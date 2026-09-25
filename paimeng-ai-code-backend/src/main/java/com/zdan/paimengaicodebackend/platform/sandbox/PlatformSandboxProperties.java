package com.zdan.paimengaicodebackend.platform.sandbox;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * 受控 Run 执行的 Sandbox 配置（Issue #77 / T-05）。
 *
 * <p>默认值与 {@code infra/docker/sandbox/Dockerfile} 的实测基线一致，改动任一侧都需重新
 * 跑隔离验证。
 */
@Data
@Component
@ConfigurationProperties(prefix = "platform.sandbox")
public class PlatformSandboxProperties {

    /**
     * Sandbox 执行总开关。默认关闭：执行器独占 Docker API（AD-016），未显式开启时不应可用。
     */
    private boolean enabled = false;

    /**
     * 模板镜像。执行器不联网拉取，镜像缺失时快速失败并提示构建命令。
     */
    private String imageReference = "paimeng-ai-code-sandbox:0.1.0";

    /**
     * Docker Engine 地址。留空则走 docker-java 默认发现（DOCKER_HOST 或本机 socket）。
     */
    private String dockerHost = "";

    /**
     * 以下限额取自 AD-016（{@code Locked Decision}）规定的固定值：
     * 2 vCPU、4 GiB 内存、256 PIDs、2 GiB Workspace tmpfs、512 MiB {@code /tmp} tmpfs。
     * 改动默认值等于偏离该决定，须先更新架构决策。
     */
    private long memoryLimitMb = 4096L;

    private double cpuLimit = 2.0d;

    private long pidsLimit = 256L;

    /**
     * Workspace 为容器内 tmpfs，不是宿主机目录挂载（AD-016 禁止宿主机目录挂载）。
     * 容器删除即随之消失；需要留存的事实由 Platform 在受信任边界提取。
     */
    private long workspaceTmpfsSizeMb = 2048L;

    private long tmpfsSizeMb = 512L;

    /**
     * 优雅停止窗口：先 SIGTERM，超时再 SIGKILL。
     */
    private int stopTimeoutSeconds = 10;

    private int defaultCommandTimeoutSeconds = 300;

    /**
     * 调用方可请求的最大命令超时。无上限意味着一次请求可以长期占住容器与 Lease，
     * 因此这里钉一个硬顶（{@code .agents/rules/errors.md}：设置明确超时、快速失败）。
     */
    private int maxCommandTimeoutSeconds = 900;
}
