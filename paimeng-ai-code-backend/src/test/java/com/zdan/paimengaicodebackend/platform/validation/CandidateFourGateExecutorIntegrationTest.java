package com.zdan.paimengaicodebackend.platform.validation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.github.dockerjava.api.DockerClient;
import com.zdan.paimengaicodebackend.platform.entity.CandidateSourceSnapshot;
import com.zdan.paimengaicodebackend.platform.entity.ProfileDisposition;
import com.zdan.paimengaicodebackend.mapper.platform.ProfileDispositionMapper;
import com.zdan.paimengaicodebackend.platform.docker.PlatformDockerClientConfiguration;
import com.zdan.paimengaicodebackend.platform.docker.PlatformDockerProperties;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxProperties;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateGitStore;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateSnapshotService;
import com.zdan.paimengaicodebackend.platform.snapshot.SnapshotReference;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.support.StaticListableBeanFactory;

class CandidateFourGateExecutorIntegrationTest {
    @TempDir Path root;

    @Test
    void runsFourGatesOnlyOnRealCandidateSnapshot() throws Exception {
        try (DockerClient docker = new PlatformDockerClientConfiguration().platformDockerClient(new PlatformDockerProperties())) {
            try {
                docker.pingCmd().exec();
                var image = docker.inspectImageCmd("issue79-validation-runtime:local").exec();
                assumeTrue("ab59c23c9f878615a88dcc1bc03c39159abb6c8f782b86deb82cc8c22573ac26"
                    .equals(image.getConfig().getLabels().get("com.zdan.paimeng.validation.lock-sha256")),
                    "固定依赖验证镜像不存在；模板 smoke 不代表候选快照验证");
                docker.inspectImageCmd("mysql:8.0.46").exec();
            } catch (RuntimeException e) {
                assumeTrue(false, "Docker 或固定镜像不可用；不声明四门 PASS");
            }
            Files.setPosixFilePermissions(root, Set.of(PosixFilePermission.OWNER_READ,
                PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE));
            CandidateGitStore git = new CandidateGitStore(root.toString(), true);
            Path stage = git.stage();
            Path template = Path.of("../assets/application-template");
            try (var files = Files.walk(template)) {
                for (Path file : files.filter(Files::isRegularFile).toList()) {
                    Path relative = template.relativize(file);
                    if (relative.toString().startsWith("scripts/") || relative.toString().equals(".env")
                        || relative.toString().startsWith(".git") || relative.toString().equals("README.md")
                        || relative.toString().equals(".dockerignore") || relative.toString().startsWith("node_modules/")
                        || relative.toString().startsWith("dist/")) continue;
                    Path target = stage.resolve(relative);
                    Files.createDirectories(target.getParent());
                    Files.copy(file, target);
                }
            }
            var identity = git.commit(1, "run-candidate", "baseline", stage);
            var reference = new SnapshotReference(1, 2, "run-candidate", "baseline", null,
                identity.commitHash(), identity.treeHash());
            CandidateSourceSnapshot row = new CandidateSourceSnapshot();
            row.setApplicationId(1L);
            row.setTaskId(2L);
            row.setRunId("run-candidate");
            row.setBaselineHash("baseline");
            row.setCommitHash(identity.commitHash());
            row.setTreeHash(identity.treeHash());
            CandidateSnapshotService snapshots = mock(CandidateSnapshotService.class);
            when(snapshots.requireReady(1, "run-candidate")).thenReturn(row);
            ProfileDisposition disposition = new ProfileDisposition();
            disposition.setApplicationId(1L);
            disposition.setTaskId(2L);
            disposition.setRunId("run-candidate");
            disposition.setBaselineHash("baseline");
            disposition.setCommitHash(identity.commitHash());
            disposition.setTreeHash(identity.treeHash());
            disposition.setDisposition("unchanged");
            ProfileDispositionMapper dispositions = mock(ProfileDispositionMapper.class);
            when(dispositions.selectOneById("run-candidate")).thenReturn(disposition);
            var executor = new CandidateFourGateExecutor(snapshots, git, dispositions,
                new StaticListableBeanFactory(Map.of("docker", docker)).getBeanProvider(DockerClient.class),
                new ObjectMapper());
            String target = """
                {"schemaVersion":1,"checks":[{"method":"POST","path":"/api/items",
                "requestBody":{"title":"candidate verified"},"expectedStatus":201,
                "expectedBody":{"pointer":"/title","equals":"candidate verified"}}]}
                """;
            var report = executor.validate(reference, target);
            assertTrue(report.gates().stream().allMatch(CandidateFourGateExecutor.Gate::passed), report.toString());
            assertEquals(0, docker.listContainersCmd().withShowAll(true)
                .withLabelFilter(Map.of("com.zdan.paimeng.platform.validation", "candidate-app")).exec().size());
        }
    }
}
