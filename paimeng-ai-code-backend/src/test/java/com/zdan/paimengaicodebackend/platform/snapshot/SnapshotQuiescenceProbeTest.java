package com.zdan.paimengaicodebackend.platform.snapshot;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.github.dockerjava.api.DockerClient;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.github.dockerjava.api.async.ResultCallback;
import com.github.dockerjava.api.model.Frame;
import com.github.dockerjava.api.model.StreamType;
import com.zdan.paimengaicodebackend.platform.docker.PlatformDockerClientConfiguration;
import com.zdan.paimengaicodebackend.platform.docker.PlatformDockerProperties;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxExecutor;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxHandle;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxProperties;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

/** Probes the immutable Sandbox image without Spring/Flyway/DB. */
class SnapshotQuiescenceProbeTest {
    @Test
    void stopsBackgroundWriterAndExportsItsFinalBytes(@TempDir Path directory) throws Exception {
        PlatformSandboxProperties properties = new PlatformSandboxProperties();
        properties.setEnabled(true);
        try (DockerClient docker = new PlatformDockerClientConfiguration().platformDockerClient(new PlatformDockerProperties())) {
            @SuppressWarnings("unchecked")
            ObjectProvider<DockerClient> provider = mock(ObjectProvider.class);
            when(provider.getIfAvailable()).thenReturn(docker);
            PlatformSandboxExecutor sandbox = new PlatformSandboxExecutor(properties, provider);
            PlatformSandboxHandle handle = sandbox.start("snapshot-writer-" + UUID.randomUUID(), 101L);
            try {
                String writer = "node -e 'const fs=require(\"fs\");"
                    + "setInterval(()=>fs.appendFileSync(\"/workspace/source.txt\",\"x\"),5)'"
                    + " > /tmp/writer.log 2>&1 & echo $! > /workspace/writer.pid";
                assertEquals(0, sandbox.exec(handle,
                    "printf ready > /workspace/source.txt; printf '\\000\\001\\377' > /workspace/binary.dat; " + writer,
                    10, ignored -> { }, ignored -> { }));
                assertEquals(0, sandbox.exec(handle, "kill -0 $(cat /workspace/writer.pid)",
                    10, ignored -> { }, ignored -> { }));
                Path archive = directory.resolve("capture.tar");
                sandbox.exportQuiesced(handle, archive, 1024 * 1024);
                assertEquals(1, sandbox.exec(handle, "kill -0 $(cat /workspace/writer.pid)",
                    10, ignored -> { }, ignored -> { }));
                Path tree = Files.createDirectory(directory.resolve("tree"));
                try (var bytes = Files.newInputStream(archive)) {
                    SnapshotArchive.extract(bytes, tree);
                }
                String frozen = Files.readString(tree.resolve("source.txt"));
                StringBuilder workspace = new StringBuilder();
                assertEquals(0, sandbox.exec(handle, "cat /workspace/source.txt", 10,
                    chunk -> workspace.append(new String(chunk, StandardCharsets.UTF_8)), ignored -> { }));
                assertEquals(frozen, workspace.toString());
                assertEquals("ready", frozen.substring(0, 5));
                assertArrayEquals(new byte[]{0, 1, (byte) 255}, Files.readAllBytes(tree.resolve("binary.dat")));
            } finally {
                sandbox.stop(handle);
            }
        }
    }

    @Test
    void exportRejectsTruncatedTarBeforeItCanBeUsed(@TempDir Path directory) throws Exception {
        PlatformSandboxProperties properties = new PlatformSandboxProperties();
        properties.setEnabled(true);
        try (DockerClient docker = new PlatformDockerClientConfiguration().platformDockerClient(new PlatformDockerProperties())) {
            @SuppressWarnings("unchecked") ObjectProvider<DockerClient> provider = mock(ObjectProvider.class);
            when(provider.getIfAvailable()).thenReturn(docker);
            PlatformSandboxExecutor sandbox = new PlatformSandboxExecutor(properties, provider);
            PlatformSandboxHandle handle = sandbox.start("snapshot-limit-" + UUID.randomUUID(), 101L);
            try {
                assertEquals(0, sandbox.exec(handle, "printf source > /workspace/source.txt", 10,
                    ignored -> { }, ignored -> { }));
                assertThrows(BusinessException.class,
                    () -> sandbox.exportQuiesced(handle, directory.resolve("capture.tar"), 512));
            } finally {
                sandbox.stop(handle);
            }
        }
    }

    @Test
    void gitCommitRestoresSameContentToEmptyTmpfs(@TempDir Path root) throws Exception {
        PlatformSandboxProperties properties = new PlatformSandboxProperties();
        properties.setEnabled(true);
        try (DockerClient docker = new PlatformDockerClientConfiguration().platformDockerClient(new PlatformDockerProperties())) {
            @SuppressWarnings("unchecked") ObjectProvider<DockerClient> provider = mock(ObjectProvider.class);
            when(provider.getIfAvailable()).thenReturn(docker);
            PlatformSandboxExecutor sandbox = new PlatformSandboxExecutor(properties, provider);
            PlatformSandboxHandle source = sandbox.start("snapshot-source-" + UUID.randomUUID(), 101L);
            PlatformSandboxHandle target = null;
            try {
                assertEquals(0, sandbox.exec(source, "printf restored > /workspace/source.txt", 10,
                    ignored -> { }, ignored -> { }));
                Path archive = root.resolve("capture.tar");
                sandbox.exportQuiesced(source, archive, 1024 * 1024);
                Files.setPosixFilePermissions(root, Set.of(PosixFilePermission.OWNER_READ,
                    PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE));
                CandidateGitStore git = new CandidateGitStore(root.toString(), true);
                Path stage = git.stage();
                try (var bytes = Files.newInputStream(archive)) {
                    SnapshotArchive.extract(bytes, stage);
                }
                var identity = git.commit(101L, source.runId(), "baseline", stage);
                target = sandbox.start("snapshot-target-" + UUID.randomUUID(), 101L);
                Process restored = git.archive(101L, identity);
                try (var bytes = restored.getInputStream()) {
                    sandbox.restore(target, bytes);
                    assertEquals(0, restored.waitFor());
                } finally {
                    restored.destroyForcibly();
                }
                StringBuilder output = new StringBuilder();
                assertEquals(0, sandbox.exec(target, "cat /workspace/source.txt", 10,
                    chunk -> output.append(new String(chunk, StandardCharsets.UTF_8)), ignored -> { }));
                assertEquals("restored", output.toString());
            } finally {
                if (target != null) sandbox.stop(target);
                sandbox.stop(source);
            }
        }
    }

    @Test
    void quiescerSettlesForkingWriterBeforeTarStarts(@TempDir Path directory) throws Exception {
        PlatformSandboxProperties properties = new PlatformSandboxProperties();
        properties.setEnabled(true);
        try (DockerClient docker = new PlatformDockerClientConfiguration().platformDockerClient(new PlatformDockerProperties())) {
            @SuppressWarnings("unchecked") ObjectProvider<DockerClient> provider = mock(ObjectProvider.class);
            when(provider.getIfAvailable()).thenReturn(docker);
            PlatformSandboxExecutor sandbox = new PlatformSandboxExecutor(properties, provider);
            PlatformSandboxHandle handle = sandbox.start("snapshot-forks-" + UUID.randomUUID(), 101L);
            try {
                String command = "printf base > /workspace/source.txt; "
                    + "node -e 'const c=require(\"child_process\");"
                    + "setInterval(()=>c.spawn(\"sh\",[\"-c\","
                    + "\"printf x >> /workspace/source.txt\"],{stdio:\"ignore\"}),5)'"
                    + " > /tmp/forks.log 2>&1 & echo $! > /workspace/spawner.pid";
                assertEquals(0, sandbox.exec(handle, command, 10, ignored -> { }, ignored -> { }));
                assertEquals(0, sandbox.exec(handle, "kill -0 $(cat /workspace/spawner.pid)",
                    10, ignored -> { }, ignored -> { }));
                Path archive = directory.resolve("capture.tar");
                sandbox.exportQuiesced(handle, archive, 1024 * 1024);
                assertEquals(1, sandbox.exec(handle, "kill -0 $(cat /workspace/spawner.pid)",
                    10, ignored -> { }, ignored -> { }));
                Path tree = Files.createDirectory(directory.resolve("tree"));
                try (var bytes = Files.newInputStream(archive)) {
                    SnapshotArchive.extract(bytes, tree);
                }
                StringBuilder live = new StringBuilder();
                assertEquals(0, sandbox.exec(handle, "cat /workspace/source.txt", 10,
                    chunk -> live.append(new String(chunk, StandardCharsets.UTF_8)), ignored -> { }));
                assertEquals(live.toString(), Files.readString(tree.resolve("source.txt")));
            } finally {
                sandbox.stop(handle);
            }
        }
    }

    @Test
    void unreadableWorkspaceFileRejectsTarExport(@TempDir Path directory) throws Exception {
        PlatformSandboxProperties properties = new PlatformSandboxProperties();
        properties.setEnabled(true);
        try (DockerClient docker = new PlatformDockerClientConfiguration().platformDockerClient(new PlatformDockerProperties())) {
            @SuppressWarnings("unchecked") ObjectProvider<DockerClient> provider = mock(ObjectProvider.class);
            when(provider.getIfAvailable()).thenReturn(docker);
            PlatformSandboxExecutor sandbox = new PlatformSandboxExecutor(properties, provider);
            PlatformSandboxHandle handle = sandbox.start("snapshot-denied-" + UUID.randomUUID(), 101L);
            try {
                assertEquals(0, sandbox.exec(handle,
                    "printf good > /workspace/source.txt; printf secret > /workspace/unreadable;"
                        + " chmod 000 /workspace/unreadable",
                    10, ignored -> { }, ignored -> { }));
                assertThrows(BusinessException.class,
                    () -> sandbox.exportQuiesced(handle, directory.resolve("capture.tar"), 1024 * 1024));
            } finally {
                sandbox.stop(handle);
            }
        }
    }

    @Test
    void observesTrustedIdleProcessesAndTools() throws Exception {
        PlatformSandboxProperties properties = new PlatformSandboxProperties();
        properties.setEnabled(true);
        try (DockerClient docker = new PlatformDockerClientConfiguration().platformDockerClient(new PlatformDockerProperties())) {
            @SuppressWarnings("unchecked")
            ObjectProvider<DockerClient> provider = mock(ObjectProvider.class);
            when(provider.getIfAvailable()).thenReturn(docker);
            PlatformSandboxExecutor sandbox = new PlatformSandboxExecutor(properties, provider);
            PlatformSandboxHandle handle = sandbox.start("snapshot-probe-" + UUID.randomUUID(), 101L);
            try {
                StringBuilder output = new StringBuilder();
                StringBuilder errors = new StringBuilder();
                String script = "const fs=require('fs');"
                    + "const own=fs.readdirSync('/proc/self/task').length;"
                    + "const n=Number(fs.readFileSync('/sys/fs/cgroup/pids.current','utf8'));"
                    + "const children=fs.readFileSync('/proc/1/task/1/children','utf8').trim();"
                    + "process.stdout.write(`${n}:${own}:${children}`)";
                var created = docker.execCreateCmd(handle.containerId())
                    .withAttachStdout(true).withAttachStderr(true)
                    .withCmd("/usr/local/bin/node", "-e", script).exec();
                try (var result = new ResultCallback.Adapter<Frame>() {
                    @Override public void onNext(Frame frame) {
                        String text = new String(frame.getPayload(), StandardCharsets.UTF_8);
                        if (frame.getStreamType() == StreamType.STDERR) errors.append(text);
                        else output.append(text);
                    }
                }) {
                    docker.execStartCmd(created.getId()).exec(result);
                    result.awaitCompletion(10, java.util.concurrent.TimeUnit.SECONDS);
                }
                assertEquals(0, docker.inspectExecCmd(created.getId()).exec().getExitCode(),
                    errors.toString() + " stdout=" + output);
                String[] fields = output.toString().split(":");
                assertEquals(3, fields.length, output.toString());
                assertEquals(Integer.parseInt(fields[1]) + 2, Integer.parseInt(fields[0]), output.toString());
                assertEquals(1, fields[2].split(" ").length, output.toString());
            } finally {
                sandbox.stop(handle);
            }
        }
    }
}
