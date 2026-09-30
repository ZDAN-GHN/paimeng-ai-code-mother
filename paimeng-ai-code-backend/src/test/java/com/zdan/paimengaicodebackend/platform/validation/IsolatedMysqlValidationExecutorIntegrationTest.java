package com.zdan.paimengaicodebackend.platform.validation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.github.dockerjava.api.DockerClient;
import com.github.dockerjava.api.exception.NotFoundException;
import com.github.dockerjava.api.model.Capability;
import com.zdan.paimengaicodebackend.platform.entity.CandidateSourceSnapshot;
import com.zdan.paimengaicodebackend.platform.docker.PlatformDockerClientConfiguration;
import com.zdan.paimengaicodebackend.platform.docker.PlatformDockerProperties;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxProperties;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateGitStore;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateSnapshotService;
import com.zdan.paimengaicodebackend.platform.snapshot.SnapshotReference;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.Arrays;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.support.StaticListableBeanFactory;

class IsolatedMysqlValidationExecutorIntegrationTest {
    @TempDir Path root;

    @Test
    void appliesMigrationWithoutNetworkHostMountOrPersistedContainer() throws Exception {
        PlatformSandboxProperties properties = new PlatformSandboxProperties();
        try (DockerClient docker = new PlatformDockerClientConfiguration().platformDockerClient(new PlatformDockerProperties())) {
            try {
                docker.pingCmd().exec();
                docker.inspectImageCmd("mysql:8.0.46").exec();
            } catch (NotFoundException e) {
                assumeTrue(false, "本地 mysql:8.0.46 镜像不存在，不拉取镜像");
            } catch (RuntimeException e) {
                assumeTrue(false, "Docker Engine 不可达");
            }
            Files.setPosixFilePermissions(root, Set.of(PosixFilePermission.OWNER_READ,
                PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE));
            CandidateGitStore git = new CandidateGitStore(root.toString(), true);
            Path stage = git.stage();
            Path migration = stage.resolve("prisma/migrations/20260928_init/migration.sql");
            Files.createDirectories(migration.getParent());
            Files.writeString(migration, """
                CREATE TABLE `Entry` (`id` INTEGER NOT NULL AUTO_INCREMENT, PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
                ALTER TABLE `Entry` ADD COLUMN `title` VARCHAR(191) NULL;
                CREATE INDEX `Entry_title_idx` ON `Entry`(`title`);
                """);
            var identity = git.commit(1, "run-1", "baseline", stage);
            var reference = new SnapshotReference(1, 2, "run-1", "baseline", null,
                identity.commitHash(), identity.treeHash());
            CandidateSourceSnapshot row = new CandidateSourceSnapshot();
            row.setApplicationId(1L);
            row.setTaskId(2L);
            row.setRunId("run-1");
            row.setBaselineHash("baseline");
            row.setCommitHash(identity.commitHash());
            row.setTreeHash(identity.treeHash());
            CandidateSnapshotService snapshots = mock(CandidateSnapshotService.class);
            when(snapshots.requireReady(1, "run-1")).thenReturn(row);
            var executor = new IsolatedMysqlValidationExecutor(snapshots, git,
                new StaticListableBeanFactory(Map.of("docker", docker)).getBeanProvider(DockerClient.class));
            Map<String, String> label = Map.of("com.zdan.paimeng.platform.validation", "mysql-migration-probe");
            int before = docker.listContainersCmd().withShowAll(true).withLabelFilter(label).exec().size();
            CompletableFuture<IsolatedMysqlValidationExecutor.Result> future = CompletableFuture.supplyAsync(
                () -> executor.validate(reference));
            boolean inspected = false;
            try {
                for (int attempt = 0; attempt < 120 && !future.isDone(); attempt++) {
                    var containers = docker.listContainersCmd().withShowAll(true).withLabelFilter(label).exec();
                    if (containers.size() > before) {
                        var config = docker.inspectContainerCmd(containers.get(containers.size() - 1).getId())
                            .exec().getHostConfig();
                        assertEquals("none", config.getNetworkMode());
                        assertEquals(Boolean.TRUE, config.getReadonlyRootfs());
                        assertEquals(Boolean.FALSE, config.getPrivileged());
                        assertTrue(Arrays.asList(config.getCapDrop()).contains(Capability.ALL));
                        assertTrue(config.getSecurityOpts().contains("no-new-privileges:true"));
                        assertTrue(config.getBinds() == null || config.getBinds().length == 0);
                        assertEquals(1024L * 1024 * 1024, config.getMemory());
                        assertTrue(config.getTmpFs().containsKey("/var/lib/mysql"));
                        inspected = true;
                        break;
                    }
                    TimeUnit.MILLISECONDS.sleep(250);
                }
                assertEquals(new IsolatedMysqlValidationExecutor.Result(true, "PASS"),
                    future.get(150, TimeUnit.SECONDS));
                assertTrue(inspected, "未检查到隔离容器");
            } finally {
                if (!future.isDone()) future.cancel(true);
            }
            assertEquals(before, docker.listContainersCmd().withShowAll(true).withLabelFilter(label).exec().size(),
                "运行结束不得遗留容器或数据卷");
        }
    }
}
