package com.zdan.paimengaicodebackend.platform.sandbox;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.github.dockerjava.api.DockerClient;
import com.github.dockerjava.api.command.InspectContainerResponse;
import com.github.dockerjava.api.exception.NotFoundException;
import com.github.dockerjava.api.model.Capability;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

/**
 * Sandbox 的隔离属性不是应用层能自证的行为：资源限额、网络命名空间、只读根、capability
 * 与挂载面全部由 Docker 决定，因此这些断言必须打到真实容器并读回 inspect 结果。
 *
 * <p>Docker 不可用或模板镜像未构建时整类跳过，不让缺少本地依赖的环境变成构建失败。
 * 构建镜像：{@code docker build -t paimeng-ai-code-sandbox:0.1.0 infra/docker/sandbox}
 */
@SpringBootTest(properties = "platform.sandbox.enabled=true")
class PlatformSandboxExecutorIntegrationTest {

    private static final AtomicLong RUN_ID_SEQUENCE = new AtomicLong(9_900_000L);

    @Autowired
    private PlatformSandboxExecutor executor;

    @Autowired
    private PlatformSandboxProperties properties;

    @Autowired
    private DockerClient dockerClient;

    private PlatformSandboxHandle handle;

    @BeforeEach
    void requireDockerAndImage() {
        try {
            dockerClient.pingCmd().exec();
        } catch (RuntimeException e) {
            assumeTrue(false, "Docker Engine 不可达，跳过 Sandbox 隔离验证");
        }
        try {
            dockerClient.inspectImageCmd(properties.getImageReference()).exec();
        } catch (NotFoundException e) {
            assumeTrue(false, "模板镜像未构建，跳过 Sandbox 隔离验证：" + properties.getImageReference());
        }
    }

    @AfterEach
    void cleanup() {
        if (handle != null) {
            try {
                executor.stop(handle);
            } catch (RuntimeException e) {
                // 清理失败不应掩盖用例本身的断言结果。
            }
            handle = null;
        }
    }

    @Test
    void startsContainerUnderDeclaredIsolationConstraints() {
        handle = executor.start(nextRunId(), 1L);

        InspectContainerResponse inspect = dockerClient.inspectContainerCmd(handle.containerId()).exec();
        assertNotNull(inspect.getHostConfig());

        assertEquals("none", inspect.getHostConfig().getNetworkMode(), "必须无网络命名空间");
        assertEquals(Boolean.TRUE, inspect.getHostConfig().getReadonlyRootfs(), "根文件系统必须只读");
        assertEquals(Boolean.TRUE, inspect.getHostConfig().getInit(), "必须启用 init，否则 SIGTERM 不被转发");
        assertEquals(Boolean.FALSE, inspect.getHostConfig().getPrivileged(), "不得特权运行");

        assertEquals(
            properties.getMemoryLimitMb() * 1024L * 1024L,
            inspect.getHostConfig().getMemory(),
            "内存限额未落地"
        );
        assertEquals(
            (long) (properties.getCpuLimit() * 1_000_000_000L),
            inspect.getHostConfig().getNanoCPUs(),
            "CPU 限额未落地"
        );
        assertEquals(properties.getPidsLimit(), inspect.getHostConfig().getPidsLimit(), "进程数限额未落地");

        assertTrue(
            Arrays.asList(inspect.getHostConfig().getCapDrop()).contains(Capability.ALL),
            "必须丢弃全部 capability"
        );
        assertTrue(
            inspect.getHostConfig().getSecurityOpts().contains("no-new-privileges:true"),
            "必须禁止提权"
        );
    }

    @Test
    void pinsResourceLimitsToArchitectureDecision() {
        // AD-016 是 Locked Decision，限额为固定值而非可调参数。
        // 上面那些断言只验证「配置被落地」，配置本身写错时同样通过，因此这里钉住字面值。
        assertEquals(4096L, properties.getMemoryLimitMb(), "AD-016 规定 4 GiB 内存");
        assertEquals(2.0d, properties.getCpuLimit(), "AD-016 规定 2 vCPU");
        assertEquals(256L, properties.getPidsLimit(), "AD-016 规定 256 PIDs");
        assertEquals(2048L, properties.getWorkspaceTmpfsSizeMb(), "AD-016 规定 2 GiB Workspace tmpfs");
        assertEquals(512L, properties.getTmpfsSizeMb(), "AD-016 规定 512 MiB /tmp tmpfs");
    }

    @Test
    void neverMountsHostPathsAndServesWorkspaceFromTmpfs() {
        handle = executor.start(nextRunId(), 1L);

        InspectContainerResponse inspect = dockerClient.inspectContainerCmd(handle.containerId()).exec();

        // AD-016 禁止宿主机目录挂载。零 bind 是唯一能同时排除 Docker Socket、宿主机凭据
        // 与静态资源目录的形状——逐个黑名单会漏。
        List<String> binds = inspect.getHostConfig().getBinds() == null
            ? List.of()
            : Arrays.stream(inspect.getHostConfig().getBinds())
                .map(bind -> bind.getPath() + ":" + bind.getVolume().getPath())
                .toList();
        assertTrue(binds.isEmpty(), "不得存在任何宿主机挂载，实际：" + binds);

        Map<String, String> tmpFs = inspect.getHostConfig().getTmpFs();
        assertNotNull(tmpFs, "workspace 必须由 tmpfs 提供");
        assertTrue(tmpFs.containsKey("/workspace"), "workspace 必须由 tmpfs 提供，实际：" + tmpFs);
        assertTrue(tmpFs.containsKey("/tmp"), "/tmp 必须由 tmpfs 提供，实际：" + tmpFs);

        // inspect 只能证明「声明了 tmpfs」。容器内实际可写、且属主与 USER 对齐，
        // 只有在容器里写一次才能证明——tmpfs 默认属主是 root，挂载选项写错时这里才会失败。
        StringBuilder probe = new StringBuilder();
        int exitCode = executor.exec(
            handle,
            "grep -q ' /workspace tmpfs ' /proc/mounts && echo tmpfs-ok"
                + " && touch /workspace/probe && echo write-ok",
            30,
            chunk -> probe.append(new String(chunk, StandardCharsets.UTF_8)),
            null
        );
        assertEquals(0, exitCode, "workspace tmpfs 探测失败：" + probe);
        assertTrue(probe.toString().contains("tmpfs-ok"), "/workspace 不是 tmpfs：" + probe);
        assertTrue(probe.toString().contains("write-ok"), "/workspace 对容器身份不可写：" + probe);
    }

    @Test
    void deniesNetworkEgressFromInsideContainer() {
        handle = executor.start(nextRunId(), 1L);

        StringBuilder stdout = new StringBuilder();
        int interfacesExit = executor.exec(
            handle,
            "ls /sys/class/net | tr '\\n' ' '",
            30,
            chunk -> stdout.append(new String(chunk, StandardCharsets.UTF_8)),
            null
        );
        assertEquals(0, interfacesExit);
        assertEquals("lo", stdout.toString().trim(), "除回环外不应存在网卡");

        // 无网络命名空间下连接必然失败；非零退出码即「外连被拒」的证据。
        int egressExit = executor.exec(
            handle,
            "node -e \"require('net').connect(443,'registry.npmjs.org')"
                + ".on('error',()=>process.exit(3)).on('connect',()=>process.exit(0))\"",
            30,
            null,
            null
        );
        assertEquals(3, egressExit, "容器内不应能建立外部连接");
    }

    @Test
    void cannotReadHostCredentialsOrDockerSocket() {
        handle = executor.start(nextRunId(), 1L);

        // 宿主机凭据不会被挂载。检查存在性而不读取任何真实密钥或把其内容写入日志。
        // 容器内的 root 文件系统属于镜像本身，不能把 /etc/passwd 误当作宿主机文件。
        int credentialsExit = executor.exec(
            handle,
            "test ! -e /var/run/docker.sock && test ! -e /root/.aws/credentials"
                + " && test ! -e /root/.config/gcloud/application_default_credentials.json"
                + " && test ! -e /home/node/.npmrc && test ! -e /home/node/.pi/agent/auth.json",
            30,
            null,
            null
        );
        assertEquals(0, credentialsExit, "容器不得获得 Docker Socket 或宿主机凭据文件");

        int escapeExit = executor.exec(
            handle,
            "touch /workspace/../etc/escape-probe",
            30,
            null,
            null
        );
        assertTrue(escapeExit != 0, "通过 .. 越过 workspace 后，镜像根目录仍必须只读");
    }

    @Test
    void anotherRunCannotReadTheFirstRunsWorkspace() {
        handle = executor.start(nextRunId(), 1L);
        String sentinel = "isolation-probe-" + nextRunId();
        assertEquals(
            0,
            executor.exec(handle, "printf '%s' 'run-one' > /workspace/" + sentinel, 30, null, null)
        );

        PlatformSandboxHandle other = executor.start(nextRunId(), 1L);
        try {
            assertEquals(
                0,
                executor.exec(other, "test ! -e /workspace/" + sentinel, 30, null, null),
                "不同 Run 的 tmpfs 必须物理隔离，不能读取对方文件"
            );
            assertEquals(
                0,
                executor.exec(handle, "test -f /workspace/" + sentinel, 30, null, null),
                "第一容器中的文件必须仍然存在，以排除假阴性"
            );
        } finally {
            executor.stop(other);
        }
    }

    @Test
    void reportsExitCodeAndRoutesStreamsSeparately() {
        handle = executor.start(nextRunId(), 1L);

        List<String> stdout = new ArrayList<>();
        List<String> stderr = new ArrayList<>();
        int exitCode = executor.exec(
            handle,
            "echo to-stdout; echo to-stderr 1>&2; exit 7",
            30,
            chunk -> stdout.add(new String(chunk, StandardCharsets.UTF_8)),
            chunk -> stderr.add(new String(chunk, StandardCharsets.UTF_8))
        );

        assertEquals(7, exitCode, "非零退出码是命令的正常结果，须原样返回");
        assertTrue(String.join("", stdout).contains("to-stdout"), "stdout 未捕获");
        assertTrue(String.join("", stderr).contains("to-stderr"), "stderr 未按流类型分发");
    }

    @Test
    void reportsSignalTerminationAsOneHundredTwentyEightPlusSignal() {
        handle = executor.start(nextRunId(), 1L);

        int exitCode = executor.exec(handle, "kill -TERM $$", 30, null, null);

        assertEquals(143, exitCode, "SIGTERM 终止应报 128 + 15");
    }

    @Test
    void failsFastWhenCommandExceedsTimeout() {
        handle = executor.start(nextRunId(), 1L);

        BusinessException exception = assertThrows(
            BusinessException.class,
            () -> executor.exec(handle, "sleep 30", 1, null, null)
        );

        assertTrue(exception.getMessage().contains("超时"), "超时须快速失败且消息可行动");
    }

    @Test
    void removesContainerOnStop() {
        PlatformSandboxHandle started = executor.start(nextRunId(), 1L);
        String containerId = started.containerId();

        executor.stop(started);
        handle = null;

        assertThrows(
            NotFoundException.class,
            () -> dockerClient.inspectContainerCmd(containerId).exec(),
            "停止后容器必须已删除，否则会泄漏容器与卷"
        );
    }

    /**
     * 领域 run id 是 {@code VARCHAR(64)} 且由应用赋值（{@code @Id(keyType = KeyType.None)}），
     * 不保证是数字串。这里刻意用非数字值，防止执行器签名退回 {@code Long}。
     */
    private static String nextRunId() {
        return "run-it-" + RUN_ID_SEQUENCE.incrementAndGet();
    }
}
