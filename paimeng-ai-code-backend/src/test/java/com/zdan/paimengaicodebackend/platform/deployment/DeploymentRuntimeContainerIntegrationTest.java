package com.zdan.paimengaicodebackend.platform.deployment;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.github.dockerjava.api.DockerClient;
import com.github.dockerjava.api.async.ResultCallback;
import com.github.dockerjava.api.model.Frame;
import com.github.dockerjava.api.exception.NotFoundException;
import com.github.dockerjava.api.model.Container;
import com.zdan.paimengaicodebackend.platform.entity.PlatformDeployment;
import com.github.dockerjava.api.model.HostConfig;
import com.github.dockerjava.api.model.PortBinding;
import com.github.dockerjava.api.model.RestartPolicy;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.platform.docker.PlatformDockerClientConfiguration;
import com.zdan.paimengaicodebackend.platform.docker.PlatformDockerProperties;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 真实容器链路验收（Issue #81 / T-09）
 *
 * <p>补的是交付记录里唯一未验证的一段：真实 Docker 容器启动 → 容器内 {@code GET /healthz}
 * 通过 → 公开 URL 实际可访问。此前这段只有编译期与结构测试覆盖。
 *
 * <p>全程使用隔离网络与隔离数据库容器，不接触项目基础设施、宿主机端口或任何 Production 数据。
 * 镜像或 Docker 不可用时 {@code assumeTrue} 跳过，不伪报通过——与 #79 的隔离门禁测试同一约定。
 */
class DeploymentRuntimeContainerIntegrationTest {

    private static final String RUNTIME_IMAGE = "paimeng-application-runtime:0.1.0";
    private static final String MYSQL_IMAGE = "mysql:8.0.46";
    private static final String NETWORK = "paimeng-t09-verify";
    private static final long APPLICATION_ID = 460017668615995392L;
    private static final String RELEASE_ID = "rel-0123456789abcdef0123456789abcdef";
    private static final String DATABASE = "demo";
    private static final String ROOT_USER = "root";
    private static final String MIGRATION =
        "../assets/application-template/prisma/migrations/20260928000000_create_item/migration.sql";

    private static DockerClient docker;

    private PlatformDeploymentProperties properties;
    private PlatformDeploymentExecutor executor;
    private PlatformDeploymentHealthProbe probe;
    private String mysqlContainerId;
    private String startedContainerId;

    @BeforeAll
    static void connectToDocker() {
        docker = new PlatformDockerClientConfiguration().platformDockerClient(new PlatformDockerProperties());
        try {
            docker.pingCmd().exec();
            docker.inspectImageCmd(RUNTIME_IMAGE).exec();
            docker.inspectImageCmd(MYSQL_IMAGE).exec();
        } catch (NotFoundException missingImage) {
            assumeTrue(false, "缺少固定镜像：先执行 infra/docker/deployment/build.sh 构建 "
                + RUNTIME_IMAGE);
        } catch (RuntimeException unreachable) {
            assumeTrue(false, "Docker Engine 不可达；不声明真实容器链路已验证");
        }
    }

    @AfterAll
    static void closeDocker() throws Exception {
        if (docker != null) {
            docker.close();
        }
    }

    @BeforeEach
    void setUp() {
        ensureNetwork();
        mysqlContainerId = null;
        startedContainerId = null;

        properties = new PlatformDeploymentProperties();
        properties.setEnabled(true);
        properties.setRuntimeProfile("NODE_20");
        properties.setImageReference(RUNTIME_IMAGE);
        properties.setNetworkName(NETWORK);
        properties.setProbeRequestTimeoutSeconds(3);
        properties.setReadinessDeadlineSeconds(90);
        properties.setProbeRetryIntervalMs(500L);
        // 默认留空：先证明缺配置时不会留下任何容器，再由夹具注入真实连接串。
        properties.setManagedDatabaseUrl("");

        @SuppressWarnings("unchecked")
        var provider = Mockito.mock(org.springframework.beans.factory.ObjectProvider.class);
        Mockito.when(provider.getIfAvailable()).thenReturn(docker);
        executor = new PlatformDeploymentExecutor(properties, provider);
        probe = new PlatformDeploymentHealthProbe(properties);
    }

    @AfterEach
    void stopContainers() throws Exception {
        if (startedContainerId != null) {
            removeQuietly(startedContainerId);
        }
        if (mysqlContainerId != null) {
            removeQuietly(mysqlContainerId);
        }
    }

    @Test
    void missingManagedDatabaseUrlFailsBeforeCreatingAnyContainer() {
        PlatformDeploymentFailureException rejection = assertThrows(
            PlatformDeploymentFailureException.class,
            () -> executor.start(APPLICATION_ID, RELEASE_ID));

        assertEquals(PlatformDeploymentReasonCode.RUNTIME_CONFIGURATION_MISSING, rejection.reasonCode());
        assertEquals(0, deploymentContainers().size(), "缺少运行时配置时不得留下任何容器");
    }

    @Test
    void deploymentDisabledRefusesToTouchDocker() {
        properties.setEnabled(false);

        BusinessException rejection = assertThrows(BusinessException.class,
            () -> executor.start(APPLICATION_ID, RELEASE_ID));

        assertTrue(rejection.getMessage().contains("platform.deployment.enabled"));
        assertEquals(0, deploymentContainers().size());
    }

    @Test
    void missingRuntimeImageIsReportedWithAControlledReasonCodeAndNoLeftoverContainer() {
        properties.setImageReference("paimeng-application-runtime:does-not-exist");
        properties.setManagedDatabaseUrl("mysql://demo:x@127.0.0.1:3306/demo");

        PlatformDeploymentFailureException rejection = assertThrows(
            PlatformDeploymentFailureException.class,
            () -> executor.start(APPLICATION_ID, RELEASE_ID));

        assertEquals(PlatformDeploymentReasonCode.RUNTIME_IMAGE_UNAVAILABLE, rejection.reasonCode());
        assertEquals(0, deploymentContainers().size(), "镜像缺失不得留下容器");
    }

    /**
     * 核心链路：隔离 MySQL 就绪 → 真实应用容器启动 → 容器内健康检查通过 → 公开路径形态可访问。
     */
    @Test
    void healthyContainerServesItsOwnApiOverTheInternalNetworkOnly() throws Exception {
        startIsolatedMysql();
        applyFixtureMigration();

        PlatformDeploymentExecutor.Handle handle = executor.start(APPLICATION_ID, RELEASE_ID);
        startedContainerId = handle.containerId();

        assertNotNull(handle.address(), "容器必须在内部 Deployment network 上拿到地址");
        assertFalse(handle.address().isBlank());

        // AD-016：不发布宿主机端口。可达性只能来自内部网络。
        var bindings = docker.inspectContainerCmd(handle.containerId()).exec()
            .getHostConfig().getPortBindings().getBindings();
        assertTrue(bindings == null || bindings.isEmpty(),
            "Deployment 容器不得发布宿主机端口映射，实际: " + bindings);

        // 容器确实只在 Platform 独占的内部网络上。
        Set<String> networks = docker.inspectContainerCmd(handle.containerId()).exec()
            .getNetworkSettings().getNetworks().keySet();
        assertEquals(Set.of(NETWORK), networks, "容器只允许加入 Platform 独占的内部网络");

        // 真实 HTTP 探测：走容器内部地址，不经过公开路径。
        assertEquals(PlatformDeploymentHealthProbe.Outcome.HEALTHY, waitForHealth(handle.address()),
            "容器内 GET /healthz 必须真实通过");

        // 公开路径形态（AD-017）：/apps/<application-id>/... 由 Platform 剥前缀后转发到容器。
        // 这里直连容器内部地址以证明被转发到的是应用自身的响应。
        HttpResponse<String> api = httpGet("http://" + handle.address() + ":" + properties.getInternalPort()
            + "/api/items");
        assertEquals(200, api.statusCode());
        assertTrue(api.body().startsWith("["),
            "必须转发到应用自身的 API 响应，而非 Platform 编造内容: " + api.body());
    }

    /**
     * 公开 URL 闭环：真实健康容器 → 真实路由裁决 → 真实反向代理 → 应用自身响应。
     *
     * <p>本用例把「健康通过」「公开 URL 可用」两段串成一条链：resolver 与 controller 都是
     * 真实实现，只有两个 Mapper 被替身化（它们需要完整 Spring 上下文与 Flyway），
     * 替身返回的是上面那个真实容器的内部地址。因此响应必然来自真实运行的应用进程。
     */
    @Test
    void publicUrlProxiesToTheRealHealthyContainer() throws Exception {
        startIsolatedMysql();
        applyFixtureMigration();

        PlatformDeploymentExecutor.Handle handle = executor.start(APPLICATION_ID, RELEASE_ID);
        startedContainerId = handle.containerId();
        assertEquals(PlatformDeploymentHealthProbe.Outcome.HEALTHY, waitForHealth(handle.address()),
            "容器必须先真实健康，公开路径才允许挂载");

        var releaseMapper = Mockito.mock(
            com.zdan.paimengaicodebackend.mapper.platform.PlatformReleaseMapper.class);
        var deploymentMapper = Mockito.mock(
            com.zdan.paimengaicodebackend.mapper.platform.PlatformDeploymentMapper.class);
        var healthy = new PlatformDeployment();
        healthy.setId(1L);
        healthy.setApplicationId(APPLICATION_ID);
        healthy.setReleaseId(RELEASE_ID);
        healthy.setContainerAddress(handle.address());
        Mockito.when(deploymentMapper.selectHealthyForApplication(APPLICATION_ID)).thenReturn(healthy);

        var routes = new PublicApplicationRouteResolver(releaseMapper, deploymentMapper, properties);
        assertEquals(PublicApplicationRouteResolver.Status.LIVE, routes.resolve(APPLICATION_ID).status(),
            "存在真实健康 Deployment 时公开路径必须挂载");

        MockMvc mockMvc = MockMvcBuilders
            .standaloneSetup(new com.zdan.paimengaicodebackend.platform.controller
                .PlatformPublicApplicationController(routes, properties))
            .build();

        MvcResult result = mockMvc.perform(get("/apps/{applicationId}/api/items", APPLICATION_ID))
            .andExpect(status().isOk())
            .andReturn();

        String body = result.getResponse().getContentAsString();
        assertTrue(body.startsWith("["),
            "公开路径必须返回真实应用进程的响应，而非 Platform 编造内容: " + body);
    }

    @Test
    void restartingTheSameReleaseReplacesInsteadOfDuplicatingTheContainer() throws Exception {
        startIsolatedMysql();
        applyFixtureMigration();

        String firstContainer = executor.start(APPLICATION_ID, RELEASE_ID).containerId();
        assertEquals(1, deploymentContainers().size());

        String secondContainer = executor.start(APPLICATION_ID, RELEASE_ID).containerId();
        startedContainerId = secondContainer;

        // Platform 可能在容器已启动、状态未落库时被终止；重试不得让同一 Release 同时跑两个实例。
        assertFalse(firstContainer.equals(secondContainer), "重试必须替换旧容器，而不是复用");
        assertEquals(1, deploymentContainers().size(), "同一 Release 同时只能存在一个容器");
    }

    // ---- 隔离数据库夹具 ----

    private void ensureNetwork() {
        try {
            docker.inspectNetworkCmd().withNetworkId(NETWORK).exec();
        } catch (NotFoundException missing) {
            docker.createNetworkCmd().withName(NETWORK).withDriver("bridge").withCheckDuplicate(true).exec();
        }
    }

    private void startIsolatedMysql() throws Exception {
        var created = docker.createContainerCmd(MYSQL_IMAGE)
            .withName("paimeng-t09-verify-mysql")
            .withHostConfig(HostConfig.newHostConfig()
                .withNetworkMode(NETWORK)
                .withPortBindings(List.<PortBinding>of())
                .withRestartPolicy(RestartPolicy.noRestart()))
            // 与 #79 的隔离 MySQL 门禁一致：不设任何口令，容器是临时的、只挂在隔离网络上、
            // 不发布宿主机端口。给测试容器硬编码一个"测试口令"并不会更安全，只会让真实
            // 口令的检索规则出现例外，而这个例外的边界很难在评审时说清。
            .withEnv("MYSQL_ALLOW_EMPTY_PASSWORD=yes", "MYSQL_DATABASE=" + DATABASE)
            .exec();
        mysqlContainerId = created.getId();
        docker.startContainerCmd(mysqlContainerId).exec();

        // 只连这个隔离容器自己的内部地址，不碰项目基础设施的 3306。
        String address = null;
        long deadline = System.nanoTime() + Duration.ofSeconds(90).toNanos();
        RuntimeException last = null;
        while (System.nanoTime() < deadline) {
            try {
                exec(mysqlContainerId, List.of(
                    "mysql", "-h", "127.0.0.1", "--user=" + ROOT_USER,
                    DATABASE, "--execute=SELECT 1;"));
                address = docker.inspectContainerCmd(mysqlContainerId).exec().getNetworkSettings()
                    .getNetworks().get(NETWORK).getIpAddress();
                break;
            } catch (RuntimeException notReady) {
                last = notReady;
                sleep(1000L);
            }
        }
        if (address == null) {
            throw new IllegalStateException("隔离 MySQL 未在 90 秒内就绪", last);
        }
        properties.setManagedDatabaseUrl("mysql://" + ROOT_USER + "@" + address + ":3306/" + DATABASE);
    }

    /**
     * 用隔离 MySQL 应用固定模板的初始迁移。
     *
     * <p>这一段是测试夹具而非被测对象：Migration Gate 已由 #79 的 Database Gate 判定过，
     * 部署阶段面对的应当是已迁移的库。直接执行候选快照的同一份 SQL，避免测的是另一套迁移路径。
     */
    private void applyFixtureMigration() throws Exception {
        Path migration = Path.of(MIGRATION);
        assumeTrue(Files.exists(migration), "缺少固定模板迁移脚本: " + MIGRATION);
        String sql = Files.readString(migration, StandardCharsets.UTF_8);
        exec(mysqlContainerId, List.of(
            "mysql", "-h", "127.0.0.1", "--user=" + ROOT_USER,
            DATABASE, "--execute=" + sql));
    }

    private PlatformDeploymentHealthProbe.Outcome waitForHealth(String address) {
        long deadline = System.nanoTime() + Duration.ofSeconds(60).toNanos();
        PlatformDeploymentHealthProbe.Outcome last = PlatformDeploymentHealthProbe.Outcome.FAILED;
        while (System.nanoTime() < deadline) {
            last = probe.probe(address, properties.getInternalPort());
            if (last == PlatformDeploymentHealthProbe.Outcome.HEALTHY) {
                return last;
            }
            sleep(500L);
        }
        return last;
    }

    private HttpResponse<String> httpGet(String url) throws Exception {
        return HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build()
            .send(HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(5)).GET().build(),
                HttpResponse.BodyHandlers.ofString());
    }

    /**
     * 在隔离容器内执行命令，失败即抛错。输出只用于失败诊断，不做断言。
     *
     * <p>只连容器自己的回环地址：这是测试夹具的 MySQL，不经过任何内部网络暴露面。
     */
    private void exec(String containerId, List<String> command) throws Exception {
        var created = docker.execCreateCmd(containerId)
            .withCmd(command.toArray(String[]::new))
            .withUser("root")
            .withAttachStdout(true)
            .withAttachStderr(true)
            .exec();
        try (ResultCallback.Adapter<Frame> callback = new ResultCallback.Adapter<>()) {
            docker.execStartCmd(created.getId()).exec(callback);
            callback.awaitCompletion(90, TimeUnit.SECONDS);
        } catch (RuntimeException failure) {
            throw new IllegalStateException("命令在容器内失败: " + String.join(" ", command), failure);
        }
        Long exit = docker.inspectExecCmd(created.getId()).exec().getExitCodeLong();
        if (exit == null || exit != 0L) {
            throw new IllegalStateException("命令在容器内失败(exit=" + exit + "): " + String.join(" ", command));
        }
    }

    private List<Container> deploymentContainers() {
        return docker.listContainersCmd()
            .withShowAll(true)
            .withLabelFilter(Map.of(
                "com.zdan.paimeng.platform.deployment.managed-by", "platform-deployment-executor",
                "com.zdan.paimeng.platform.deployment.release-id", RELEASE_ID))
            .exec();
    }

    private void removeQuietly(String containerId) {
        try {
            docker.removeContainerCmd(containerId).withForce(true).withRemoveVolumes(true).exec();
        } catch (RuntimeException ignored) {
            // 清理失败不掩盖测试本身的结论。
        }
    }

    private void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("等待被中断", interrupted);
        }
    }
}