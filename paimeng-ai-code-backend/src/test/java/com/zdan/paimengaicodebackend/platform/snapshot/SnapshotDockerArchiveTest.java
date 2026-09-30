package com.zdan.paimengaicodebackend.platform.snapshot;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.github.dockerjava.api.DockerClient;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.platform.docker.PlatformDockerClientConfiguration;
import com.zdan.paimengaicodebackend.platform.docker.PlatformDockerProperties;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxExecutor;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxHandle;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxProperties;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.ObjectProvider;

/** Runs with a manually constructed Docker client; never loads a Spring context or Flyway. */
class SnapshotDockerArchiveTest {
    @Test
    void pausedContainerArchiveRejectsDirectoryOnlyExport(@TempDir Path stage) throws Exception {
        PlatformSandboxProperties properties = new PlatformSandboxProperties();
        properties.setEnabled(true);
        try (DockerClient docker = new PlatformDockerClientConfiguration().platformDockerClient(new PlatformDockerProperties())) {
            var provider = mockDockerProvider(docker);
            PlatformSandboxExecutor sandbox = new PlatformSandboxExecutor(properties, provider);
            String runId = "snapshot-archive-" + java.util.UUID.randomUUID();
            PlatformSandboxHandle handle = sandbox.start(runId, 101L);
            try {
                assertEquals(0, sandbox.exec(handle, "printf frozen > /workspace/source.txt", 10,
                    ignored -> { }, ignored -> { }));
                ByteArrayOutputStream collected = new ByteArrayOutputStream();
                docker.pauseContainerCmd(handle.containerId()).exec();
                try {
                    assertTrue(Boolean.TRUE.equals(docker.inspectContainerCmd(handle.containerId())
                        .exec().getState().getPaused()));
                    try (var source = docker.copyArchiveFromContainerCmd(handle.containerId(),
                        "/workspace").exec()) {
                        source.transferTo(collected);
                    }
                } finally {
                    docker.unpauseContainerCmd(handle.containerId()).exec();
                }
                assertFalse(Boolean.TRUE.equals(docker.inspectContainerCmd(handle.containerId())
                    .exec().getState().getPaused()));
                List<String> names = names(collected.toByteArray());
                if (names.equals(List.of("workspace/"))) {
                    assertThrows(BusinessException.class, () -> SnapshotArchive.extract(
                        new ByteArrayInputStream(collected.toByteArray()), stage));
                    assertFalse(Files.exists(stage.resolve("source.txt")));
                } else {
                    SnapshotArchive.extract(new ByteArrayInputStream(collected.toByteArray()), stage);
                    assertEquals("frozen", Files.readString(stage.resolve("source.txt")), names.toString());
                }
            } finally {
                sandbox.stop(handle);
            }
        }
    }

    private List<String> names(byte[] archive) throws IOException {
        List<String> names = new ArrayList<>();
        try (TarArchiveInputStream tar = new TarArchiveInputStream(new ByteArrayInputStream(archive))) {
            org.apache.commons.compress.archivers.tar.TarArchiveEntry entry;
            while ((entry = tar.getNextEntry()) != null) names.add(entry.getName());
        }
        return names;
    }

    @SuppressWarnings("unchecked")
    private ObjectProvider<DockerClient> mockDockerProvider(DockerClient docker) {
        ObjectProvider<DockerClient> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(docker);
        return provider;
    }
}
