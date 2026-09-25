package com.zdan.paimengaicodebackend.platform.sandbox;

import com.github.dockerjava.api.DockerClient;
import com.github.dockerjava.api.async.ResultCallback;
import com.github.dockerjava.api.command.CreateContainerResponse;
import com.github.dockerjava.api.command.ExecCreateCmdResponse;
import com.github.dockerjava.api.command.InspectExecResponse;
import com.github.dockerjava.api.exception.NotFoundException;
import com.github.dockerjava.api.model.Capability;
import com.github.dockerjava.api.model.Container;
import com.github.dockerjava.api.model.Frame;
import com.github.dockerjava.api.model.HostConfig;
import com.github.dockerjava.api.model.StreamType;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

/**
 * 受控 Run 执行的 Docker Sandbox 执行器（Issue #77 / T-05）。
 *
 * <p>AD-016：Docker API 由本执行器独占。TS Runtime / Pi Adapter / Sandbox 容器自身都不得持有
 * Docker Socket 或等价宿主机控制权。AD-016 同时禁止宿主机目录挂载，因此本执行器
 * <strong>不做任何 bind mount</strong>：workspace 是容器内 tmpfs，容器删除即消失，
 * 需要留存的事实由 Platform 在受信任边界提取。
 *
 * <p>隔离约束与 {@code infra/docker/sandbox/Dockerfile} 的实测基线一一对应：
 * 无网络命名空间、根文件系统只读、仅 {@code /workspace} 与 {@code /tmp} 可写、丢弃全部
 * capability、禁止提权、限制内存 / CPU / 进程数。
 */
@Slf4j
@Service
public class PlatformSandboxExecutor {

    /** 容器内 workspace 挂载点，与 Dockerfile 的 WORKDIR 一致。 */
    private static final String CONTAINER_WORKSPACE_PATH = "/workspace";

    /**
     * 容器运行身份，与 {@code infra/docker/sandbox/Dockerfile} 的 {@code USER node}
     * （uid=1000/gid=1000）一致。tmpfs 默认属主为 root，挂载选项必须与此同源，
     * 否则容器无法写入 {@code /workspace}。镜像里的 USER 变更时这里必须同步。
     */
    private static final int CONTAINER_UID = 1000;
    private static final int CONTAINER_GID = 1000;
    private static final String CONTAINER_RUN_AS_USER = CONTAINER_UID + ":" + CONTAINER_GID;

    /** 孤儿容器回收用标签：按 managed-by 可枚举出本执行器创建的全部容器。 */
    private static final String LABEL_MANAGED_BY = "com.zdan.paimeng.platform.sandbox.managed-by";
    private static final String LABEL_MANAGED_BY_VALUE = "platform-sandbox-executor";
    private static final String LABEL_RUN_ID = "com.zdan.paimeng.platform.sandbox.run-id";
    private static final String LABEL_APPLICATION_ID = "com.zdan.paimeng.platform.sandbox.application-id";

    private final PlatformSandboxProperties properties;
    private final ObjectProvider<DockerClient> dockerClientProvider;

    public PlatformSandboxExecutor(
        PlatformSandboxProperties properties,
        ObjectProvider<DockerClient> dockerClientProvider
    ) {
        this.properties = properties;
        this.dockerClientProvider = dockerClientProvider;
    }

    /**
     * 为一个 Run 创建并启动 Sandbox 容器。
     *
     * <p>workspace 由容器内 tmpfs 提供，调用方不传宿主机路径，也无法经宿主机文件系统
     * 读写该 workspace——这是 AD-016 的隔离要求，不是实现细节。
     *
     * @param runId         归属 Run
     * @param applicationId 归属 Application
     */
    public PlatformSandboxHandle start(String runId, Long applicationId) {
        long startedNanos = System.nanoTime();
        DockerClient dockerClient = requireDockerClient();
        if (runId == null || runId.isBlank() || applicationId == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "Sandbox 启动参数不完整");
        }

        CreateContainerResponse created;
        try {
            created = dockerClient.createContainerCmd(properties.getImageReference())
                .withLabels(Map.of(
                    LABEL_MANAGED_BY, LABEL_MANAGED_BY_VALUE,
                    LABEL_RUN_ID, runId,
                    LABEL_APPLICATION_ID, String.valueOf(applicationId)
                ))
                // 根文件系统只读，HOME 必须落在可写的 tmpfs 上。
                .withEnv(List.of("HOME=/tmp"))
                // 镜像已声明 USER node，这里再显式指定一次：镜像被替换且丢掉 USER 时，
                // 容器不会静默退回 root。
                .withUser(CONTAINER_RUN_AS_USER)
                .withWorkingDir(CONTAINER_WORKSPACE_PATH)
                .withHostConfig(buildHostConfig())
                .exec();
        } catch (NotFoundException e) {
            // 执行器不联网拉取镜像：容器内无网络，宿主机拉取也不属于受控执行职责。
            throw new BusinessException(
                ErrorCode.OPERATION_ERROR,
                "Sandbox 模板镜像不存在：" + properties.getImageReference()
                    + "，请先执行 docker build -t " + properties.getImageReference()
                    + " infra/docker/sandbox"
            );
        }

        try {
            dockerClient.startContainerCmd(created.getId()).exec();
        } catch (RuntimeException e) {
            // 失败路径也必须清理，否则留下已创建未启动的孤儿容器。
            removeQuietly(dockerClient, created.getId(), runId);
            throw e;
        }

        log.info(
            "Platform Sandbox start completed, runId: {}, applicationId: {}, containerId: {}, user: {}, result: success, durationMs: {}",
            runId,
            applicationId,
            shortContainerId(created.getId()),
            CONTAINER_RUN_AS_USER,
            TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos)
        );
        return new PlatformSandboxHandle(
            created.getId(),
            runId,
            applicationId
        );
    }

    /**
     * 在 Sandbox 容器内执行一条命令，输出以 chunk 形式推给回调。
     *
     * <p>输出背压来自回调的阻塞语义：{@code onStdout} / {@code onStderr} 未返回前
     * docker-java 不会读取下一帧，TCP 接收窗口随之收敛。回调内不要吞掉
     * {@link InterruptedException} 以外的异常，否则会掩盖真实失败。
     *
     * @param timeoutSeconds 命令执行上限，超时快速失败（不重试）
     * @return 命令退出码。信号终止由 Docker 报为 {@code 128 + signal}（如 SIGTERM → 143）
     */
    public int exec(
        PlatformSandboxHandle handle,
        String command,
        int timeoutSeconds,
        Consumer<byte[]> onStdout,
        Consumer<byte[]> onStderr
    ) {
        long startedNanos = System.nanoTime();
        DockerClient dockerClient = requireDockerClient();
        if (handle == null || command == null || command.isBlank()) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "Sandbox 命令参数不完整");
        }

        ExecCreateCmdResponse exec = dockerClient.execCreateCmd(handle.containerId())
            .withAttachStdout(true)
            .withAttachStderr(true)
            .withWorkingDir(CONTAINER_WORKSPACE_PATH)
            .withCmd("sh", "-c", command)
            .exec();

        StreamCollector collector = new StreamCollector(onStdout, onStderr);
        boolean finished;
        try {
            dockerClient.execStartCmd(exec.getId()).exec(collector);
            finished = collector.awaitCompletion(timeoutSeconds, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            closeQuietly(collector);
            throw new BusinessException(ErrorCode.OPERATION_ERROR, "Sandbox 命令执行被中断");
        }
        if (!finished) {
            closeQuietly(collector);
            log.error(
                "Platform Sandbox exec timeout, runId: {}, containerId: {}, timeoutSeconds: {}, errorClass: timeout",
                handle.runId(),
                shortContainerId(handle.containerId()),
                timeoutSeconds
            );
            throw new BusinessException(
                ErrorCode.OPERATION_ERROR,
                "Sandbox 命令执行超时（" + timeoutSeconds + " 秒）"
            );
        }

        InspectExecResponse inspect = dockerClient.inspectExecCmd(exec.getId()).exec();
        Integer exitCode = inspect.getExitCode();
        if (exitCode == null) {
            // 退出码缺失说明 Docker 未能报告终态，不能当成功。
            log.error(
                "Platform Sandbox exec exit code missing, runId: {}, containerId: {}, errorClass: dependency",
                handle.runId(),
                shortContainerId(handle.containerId())
            );
            throw new BusinessException(ErrorCode.OPERATION_ERROR, "Sandbox 命令未返回退出码");
        }

        log.info(
            "Platform Sandbox exec completed, runId: {}, containerId: {}, exitCode: {}, stdoutBytes: {}, stderrBytes: {}, durationMs: {}",
            handle.runId(),
            shortContainerId(handle.containerId()),
            exitCode,
            collector.stdoutBytes,
            collector.stderrBytes,
            TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos)
        );
        return exitCode;
    }

    /**
     * 按 Run 解析正在运行的 Sandbox 容器。
     *
     * <p>容器位置刻意不落库：Docker 本身就是该事实的权威来源，按标签查询不会出现
     * 「库里记着一个已消失容器」的漂移。容器不存在（未启动、已停止、已被回收）时返回
     * 空值，由调用方决定这是拒绝还是重建。
     */
    public Optional<PlatformSandboxHandle> find(String runId) {
        DockerClient dockerClient = requireDockerClient();
        if (runId == null || runId.isBlank()) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "Sandbox 查询参数不完整");
        }
        List<Container> containers = dockerClient.listContainersCmd()
            .withLabelFilter(Map.of(
                LABEL_MANAGED_BY, LABEL_MANAGED_BY_VALUE,
                LABEL_RUN_ID, runId
            ))
            .exec();
        if (containers.isEmpty()) {
            return Optional.empty();
        }
        if (containers.size() > 1) {
            // 一个 Run 只应有一个容器。多于一个说明清理漏了，继续用会写进不确定的那个。
            throw new BusinessException(
                ErrorCode.OPERATION_ERROR,
                "Run 存在多个 Sandbox 容器，拒绝继续执行"
            );
        }
        Container container = containers.getFirst();
        String applicationIdLabel = container.getLabels().get(LABEL_APPLICATION_ID);
        return Optional.of(new PlatformSandboxHandle(
            container.getId(),
            runId,
            applicationIdLabel == null ? null : Long.valueOf(applicationIdLabel)
        ));
    }

    /**
     * Recovery is only possible before any work has touched the original tmpfs.
     * Inspect the actual container configuration and contents, not just a cached capability value.
     */
    public void requirePristineWorkspace(PlatformSandboxHandle handle) {
        var inspected = requireDockerClient().inspectContainerCmd(handle.containerId()).exec();
        HostConfig config = inspected.getHostConfig();
        if (inspected.getState() == null || !Boolean.TRUE.equals(inspected.getState().getRunning())
            || config == null || !Boolean.TRUE.equals(config.getReadonlyRootfs())
            || !"none".equals(config.getNetworkMode())
            || config.getTmpFs() == null || !config.getTmpFs().containsKey(CONTAINER_WORKSPACE_PATH)
            || (config.getBinds() != null && config.getBinds().length > 0)) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Sandbox 配置不可确认，拒绝接管");
        }
        int exitCode = exec(
            handle,
            "node -e 'const fs=require(\"fs\");"
                + "if(!fs.statSync(\"/workspace\").isDirectory()"
                + "||fs.readdirSync(\"/workspace\").length!==0)process.exit(1)'",
            5,
            ignored -> { },
            ignored -> { }
        );
        if (exitCode != 0) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Workspace 不为空，拒绝接管");
        }
    }

    /**
     * 优雅停止并删除 Sandbox 容器：先 SIGTERM，{@code stopTimeoutSeconds} 内未退出再 SIGKILL。
     *
     * <p>容器以 {@code --init} 创建，PID 1 是 tini，SIGTERM 会被转发给业务进程；没有 init 时
     * PID 1 不响应默认处置的信号，优雅停止会退化成必然的 SIGKILL。
     */
    public void stop(PlatformSandboxHandle handle) {
        long startedNanos = System.nanoTime();
        DockerClient dockerClient = requireDockerClient();
        if (handle == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "Sandbox 停止参数不完整");
        }
        try {
            dockerClient.stopContainerCmd(handle.containerId())
                .withTimeout(properties.getStopTimeoutSeconds())
                .exec();
        } catch (NotFoundException e) {
            log.warn(
                "Platform Sandbox stop skipped, container already absent, runId: {}, containerId: {}",
                handle.runId(),
                shortContainerId(handle.containerId())
            );
        } finally {
            // 停止失败也要尝试删除，避免容器与匿名卷泄漏。
            removeQuietly(dockerClient, handle.containerId(), handle.runId());
        }
        log.info(
            "Platform Sandbox stop completed, runId: {}, containerId: {}, result: success, durationMs: {}",
            handle.runId(),
            shortContainerId(handle.containerId()),
            TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos)
        );
    }

    private HostConfig buildHostConfig() {
        return HostConfig.newHostConfig()
            // tini 作 PID 1，使 SIGTERM 能转发到业务进程。
            .withInit(true)
            // AC-4：外连必须被拒。无网络命名空间是唯一能让「网络外连被拒」成立的选项。
            .withNetworkMode("none")
            .withReadonlyRootfs(true)
            // AD-016：workspace 是容器内 tmpfs，不是宿主机目录挂载——本执行器不做任何
            // bind mount，因此不挂 Docker Socket、不挂宿主机敏感路径，也不存在宿主机
            // 侧读写该 workspace 的通路。根只读后这两处 tmpfs 是唯一可写区。
            // nosuid/nodev 收紧挂载语义；uid/gid 必须与 withUser 同源，否则容器写不进 /workspace。
            .withTmpFs(Map.of(
                CONTAINER_WORKSPACE_PATH, "rw,nosuid,nodev"
                    + ",size=" + properties.getWorkspaceTmpfsSizeMb() + "m"
                    + ",uid=" + CONTAINER_UID
                    + ",gid=" + CONTAINER_GID
                    + ",mode=0700",
                "/tmp", "rw,nosuid,nodev,size=" + properties.getTmpfsSizeMb() + "m"
                    + ",uid=" + CONTAINER_UID
                    + ",gid=" + CONTAINER_GID
                    + ",mode=0700"
            ))
            .withMemory(properties.getMemoryLimitMb() * 1024L * 1024L)
            .withNanoCPUs((long) (properties.getCpuLimit() * 1_000_000_000L))
            .withPidsLimit(properties.getPidsLimit())
            .withPrivileged(false)
            .withCapDrop(Capability.ALL)
            .withSecurityOpts(List.of("no-new-privileges:true"));
    }

    private DockerClient requireDockerClient() {
        if (!properties.isEnabled()) {
            throw new BusinessException(
                ErrorCode.FORBIDDEN_ERROR,
                "Sandbox 执行未开启（platform.sandbox.enabled=false）"
            );
        }
        DockerClient dockerClient = dockerClientProvider.getIfAvailable();
        if (dockerClient == null) {
            throw new BusinessException(ErrorCode.OPERATION_ERROR, "Sandbox Docker 客户端不可用");
        }
        return dockerClient;
    }

    private void removeQuietly(DockerClient dockerClient, String containerId, String runId) {
        try {
            dockerClient.removeContainerCmd(containerId)
                .withForce(true)
                .withRemoveVolumes(true)
                .exec();
        } catch (NotFoundException e) {
            // 已不存在即达成目标。
        } catch (RuntimeException e) {
            // 不能掩盖调用方正在抛出的根因异常，只记录。
            log.error(
                "Platform Sandbox container cleanup failed, runId: {}, containerId: {}, errorClass: dependency, cause: {}",
                runId,
                shortContainerId(containerId),
                e.getMessage()
            );
        }
    }

    private void closeQuietly(ResultCallback<Frame> callback) {
        try {
            callback.close();
        } catch (IOException e) {
            log.warn("Platform Sandbox exec callback close failed, cause: {}", e.getMessage());
        }
    }

    private static String shortContainerId(String containerId) {
        return containerId == null || containerId.length() <= 12
            ? containerId
            : containerId.substring(0, 12);
    }

    /**
     * 按流类型分发 exec 输出。{@code onNext} 阻塞即构成输出背压。
     */
    private static final class StreamCollector extends ResultCallback.Adapter<Frame> {

        private final Consumer<byte[]> onStdout;
        private final Consumer<byte[]> onStderr;
        private long stdoutBytes;
        private long stderrBytes;

        private StreamCollector(Consumer<byte[]> onStdout, Consumer<byte[]> onStderr) {
            this.onStdout = onStdout;
            this.onStderr = onStderr;
        }

        @Override
        public void onNext(Frame frame) {
            byte[] payload = frame.getPayload();
            if (payload == null || payload.length == 0) {
                return;
            }
            if (frame.getStreamType() == StreamType.STDERR) {
                stderrBytes += payload.length;
                if (onStderr != null) {
                    onStderr.accept(payload);
                }
                return;
            }
            stdoutBytes += payload.length;
            if (onStdout != null) {
                onStdout.accept(payload);
            }
        }
    }
}
