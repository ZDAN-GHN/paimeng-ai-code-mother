package com.zdan.paimengaicodebackend.platform.deployment;

import com.github.dockerjava.api.DockerClient;
import com.github.dockerjava.api.command.CreateContainerResponse;
import com.github.dockerjava.api.exception.NotFoundException;
import com.github.dockerjava.api.model.Capability;
import com.github.dockerjava.api.model.Container;
import com.github.dockerjava.api.model.ExposedPort;
import com.github.dockerjava.api.model.HostConfig;
import com.github.dockerjava.api.model.RestartPolicy;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

/**
 * Release 部署的 Docker 执行器（Issue #81 / T-09）
 *
 * <p>AD-016：Docker API 由 Platform 受控执行器独占，Deployment 容器<b>不发布宿主机端口</b>，
 * 只加入 Platform 自己的内部 Deployment network。没有任何入口能把端口映射、bind mount 或
 * Docker Socket 传进来——这些参数全部由本类按固定值构造。
 *
 * <p>AD-016 同时要求 Agent 不能创建、停止、检查或回滚 Deployment。本类因此
 * <b>没有任何 Controller</b>，只接受内部 Domain 调用；对外可达性由
 * {@code PlatformProductionBoundaryTest} 结构性断言。
 */
@Slf4j
@Service
public class PlatformDeploymentExecutor {

    /** 孤儿回收用标签：按 managed-by 可枚举出本执行器创建的全部部署容器。 */
    private static final String LABEL_MANAGED_BY = "com.zdan.paimeng.platform.deployment.managed-by";
    private static final String LABEL_MANAGED_BY_VALUE = "platform-deployment-executor";
    private static final String LABEL_RELEASE_ID = "com.zdan.paimeng.platform.deployment.release-id";
    private static final String LABEL_APPLICATION_ID = "com.zdan.paimeng.platform.deployment.application-id";

    private final PlatformDeploymentProperties properties;
    private final ObjectProvider<DockerClient> dockerClientProvider;

    public PlatformDeploymentExecutor(
        PlatformDeploymentProperties properties,
        ObjectProvider<DockerClient> dockerClientProvider
    ) {
        this.properties = properties;
        this.dockerClientProvider = dockerClientProvider;
    }

    /** 已启动的部署容器及其内部网络地址。地址只在 Platform 内部流转。 */
    public record Handle(String containerId, String address) { }

    /**
     * 从固定 Release 创建并启动一个独立应用容器。
     *
     * <p>执行前会清掉同一 Release 遗留的容器：Platform 进程可能在容器已启动、状态未落库时被
     * 终止，重试时若不先清理就会同时跑起两个实例，公开路径指向谁将不再确定。
     */
    public Handle start(Long applicationId, String releaseId) {
        DockerClient dockerClient = requireDockerClient();
        if (applicationId == null || applicationId <= 0 || releaseId == null || releaseId.isBlank()) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "部署启动参数不完整");
        }
        // 先求值再碰 Docker：缺配置属于 Platform 自身的部署前置条件不满足，
        // 若留到 createContainerCmd 的 try 内求值，受控失败会被笼统的 RuntimeException
        // 重新包装成 CONTAINER_START_FAILED，把配置问题伪装成镜像或 Docker 问题。
        List<String> environment = runtimeEnvironment();
        ensureNetwork(dockerClient);
        removeExisting(dockerClient, releaseId);

        CreateContainerResponse created;
        try {
            created = dockerClient.createContainerCmd(properties.getImageReference())
                .withName(containerName(applicationId, releaseId))
                .withLabels(Map.of(
                    LABEL_MANAGED_BY, LABEL_MANAGED_BY_VALUE,
                    LABEL_RELEASE_ID, releaseId,
                    LABEL_APPLICATION_ID, String.valueOf(applicationId)
                ))
                .withEnv(environment)
                .withExposedPorts(List.of(new ExposedPort(properties.getInternalPort())))
                .withHostConfig(buildHostConfig())
                .exec();
        } catch (NotFoundException missingImage) {
            throw new PlatformDeploymentFailureException(
                PlatformDeploymentReasonCode.RUNTIME_IMAGE_UNAVAILABLE,
                "运行时镜像不存在：" + properties.getImageReference()
                    + "，请先构建该固定镜像后再重试");
        } catch (RuntimeException createFailure) {
            throw new PlatformDeploymentFailureException(
                PlatformDeploymentReasonCode.CONTAINER_START_FAILED,
                "部署容器创建失败", createFailure);
        }

        try {
            dockerClient.startContainerCmd(created.getId()).exec();
        } catch (RuntimeException startFailure) {
            // 失败路径同样清理，否则留下「已创建未启动」的孤儿容器。
            removeQuietly(dockerClient, created.getId(), releaseId);
            throw new PlatformDeploymentFailureException(
                PlatformDeploymentReasonCode.CONTAINER_START_FAILED,
                "部署容器启动失败", startFailure);
        }

        String address = resolveAddress(dockerClient, created.getId());
        log.info(
            "Platform deployment container started, applicationId: {}, releaseId: {}, containerId: {}, network: {}, result: success",
            applicationId, releaseId, shortContainerId(created.getId()), properties.getNetworkName());
        return new Handle(created.getId(), address);
    }

    /** 容器是否仍在运行。容器已退出时继续探测只会等到超时，判定应当更早。 */
    public boolean isRunning(String containerId) {
        if (containerId == null || containerId.isBlank()) {
            return false;
        }
        try {
            var state = requireDockerClient().inspectContainerCmd(containerId).exec().getState();
            return state != null && Boolean.TRUE.equals(state.getRunning());
        } catch (NotFoundException gone) {
            return false;
        } catch (RuntimeException inspectFailure) {
            throw new PlatformDeploymentFailureException(
                PlatformDeploymentReasonCode.CONTAINER_START_FAILED,
                "部署容器状态不可确认", inspectFailure);
        }
    }

    /** 停止并删除部署容器。用于未健康部署的即时清理：不对外提供容器，自然也不该留着它跑。 */
    public void stop(String containerId, String releaseId) {
        if (containerId == null || containerId.isBlank()) {
            return;
        }
        DockerClient dockerClient = requireDockerClient();
        try {
            dockerClient.stopContainerCmd(containerId).exec();
        } catch (NotFoundException alreadyGone) {
            // 已不存在即达成目标。
        } catch (RuntimeException stopFailure) {
            log.warn("Platform deployment container stop failed, releaseId: {}, containerId: {}, cause: {}",
                releaseId, shortContainerId(containerId), stopFailure.getMessage());
        } finally {
            removeQuietly(dockerClient, containerId, releaseId);
        }
    }

    /**
     * 注入容器的运行时环境变量，白名单且全部由 Platform 决定。
     *
     * <p>{@code HOST=0.0.0.0} 不是可选项：固定模板默认只监听容器内回环（{@code server.ts}
     * 的 {@code process.env.HOST ?? '127.0.0.1'}），而 AD-016 明确 Deployment 不发布宿主机端口，
     * 可达性只能来自内部 Deployment network。不覆盖它的话，容器能启动、健康探测永远连不上，
     * 表现为「部署失败」却与代码无关——这个坑必须留在代码里而不是留给运维记忆。
     *
     * <p>刻意不注入 {@code APP_BASE_PATH}：公开入口由 Platform 的反向代理剥掉
     * {@code /apps/<application-id>/} 前缀后转发，应用因此运行在根路径。模板的 path base
     * 能力由 #79 的 Runtime Gate（SUBPATH）覆盖，不在部署路径上重复引入第二套前缀语义。
     */
    private List<String> runtimeEnvironment() {
        List<String> environment = new ArrayList<>(List.of(
            "NODE_ENV=production",
            "HOST=0.0.0.0",
            "PORT=" + properties.getInternalPort()
        ));
        String databaseUrl = properties.getManagedDatabaseUrl();
        if (databaseUrl == null || databaseUrl.isBlank()) {
            throw new PlatformDeploymentFailureException(
                PlatformDeploymentReasonCode.RUNTIME_CONFIGURATION_MISSING,
                "未配置托管数据库连接串，无法启动受管应用容器");
        }
        environment.add("DATABASE_URL=" + databaseUrl);
        return environment;
    }

    private List<Container> existingContainers(DockerClient dockerClient, String releaseId) {
        return dockerClient.listContainersCmd()
            .withShowAll(true)
            .withLabelFilter(Map.of(
                LABEL_MANAGED_BY, LABEL_MANAGED_BY_VALUE,
                LABEL_RELEASE_ID, releaseId
            ))
            .exec()
            .stream()
            .sorted(Comparator.comparingLong(
                container -> container.getCreated() == null ? 0L : container.getCreated()))
            .toList();
    }

    private void removeExisting(DockerClient dockerClient, String releaseId) {
        existingContainers(dockerClient, releaseId)
            .forEach(container -> removeQuietly(dockerClient, container.getId(), releaseId));
    }

    private void ensureNetwork(DockerClient dockerClient) {
        String networkName = properties.getNetworkName();
        try {
            dockerClient.inspectNetworkCmd().withNetworkId(networkName).exec();
            return;
        } catch (NotFoundException missing) {
            // 固定名称、bridge 驱动、无用户输入：这是一次确定性的基础设施初始化。
        }
        try {
            dockerClient.createNetworkCmd()
                .withName(networkName)
                .withDriver("bridge")
                .withCheckDuplicate(true)
                .exec();
        } catch (RuntimeException createFailure) {
            // 并发创建下另一个实例可能已经建好；确认存在即视为成功，否则才判定失败。
            if (dockerClient.listNetworksCmd().exec().stream()
                .noneMatch(network -> networkName.equals(network.getName()))) {
                throw new PlatformDeploymentFailureException(
                    PlatformDeploymentReasonCode.CONTAINER_ADDRESS_UNAVAILABLE,
                    "内部 Deployment 网络不可用：" + networkName, createFailure);
            }
        }
    }

    private String resolveAddress(DockerClient dockerClient, String containerId) {
        try {
            var networks = dockerClient.inspectContainerCmd(containerId).exec()
                .getNetworkSettings().getNetworks();
            var settings = networks == null ? null : networks.get(properties.getNetworkName());
            String address = settings == null ? null : settings.getIpAddress();
            if (address == null || address.isBlank()) {
                throw new PlatformDeploymentFailureException(
                    PlatformDeploymentReasonCode.CONTAINER_ADDRESS_UNAVAILABLE,
                    "部署容器没有内部网络地址");
            }
            return address;
        } catch (PlatformDeploymentFailureException alreadyControlled) {
            throw alreadyControlled;
        } catch (RuntimeException inspectFailure) {
            throw new PlatformDeploymentFailureException(
                PlatformDeploymentReasonCode.CONTAINER_ADDRESS_UNAVAILABLE,
                "无法读取部署容器内部网络地址", inspectFailure);
        }
    }

    private HostConfig buildHostConfig() {
        return HostConfig.newHostConfig()
            // 只加入 Platform 自己的内部网络，且不发布任何宿主机端口（AD-016）。
            .withNetworkMode(properties.getNetworkName())
            .withPublishAllPorts(false)
            .withPortBindings(new ArrayList<>())
            .withRestartPolicy(RestartPolicy.noRestart())
            .withMemory(properties.getMemoryLimitMb() * 1024L * 1024L)
            .withNanoCPUs((long) (properties.getCpuLimit() * 1_000_000_000L))
            .withPidsLimit(properties.getPidsLimit())
            .withPrivileged(false)
            .withCapDrop(Capability.ALL)
            .withSecurityOpts(List.of("no-new-privileges:true"));
    }

    private DockerClient requireDockerClient() {
        if (!properties.isEnabled()) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR,
                "部署执行未开启（platform.deployment.enabled=false）");
        }
        DockerClient dockerClient = dockerClientProvider.getIfAvailable();
        if (dockerClient == null) {
            throw new PlatformDeploymentFailureException(
                PlatformDeploymentReasonCode.CONTAINER_START_FAILED,
                "Platform Docker 客户端不可用，无法执行部署");
        }
        return dockerClient;
    }

    private String containerName(Long applicationId, String releaseId) {
        return "paimeng-app-" + applicationId + "-" + releaseId.substring(releaseId.length() - 12);
    }

    private void removeQuietly(DockerClient dockerClient, String containerId, String releaseId) {
        try {
            dockerClient.removeContainerCmd(containerId)
                .withForce(true)
                .withRemoveVolumes(true)
                .exec();
        } catch (NotFoundException gone) {
            // 已不存在即达成目标。
        } catch (RuntimeException removeFailure) {
            // 不能掩盖调用方正在抛出的根因异常，只记录。
            log.error("Platform deployment container cleanup failed, releaseId: {}, containerId: {}, cause: {}",
                releaseId, shortContainerId(containerId), removeFailure.getMessage());
        }
    }

    private static String shortContainerId(String containerId) {
        return containerId == null || containerId.length() <= 12
            ? containerId
            : containerId.substring(0, 12);
    }
}