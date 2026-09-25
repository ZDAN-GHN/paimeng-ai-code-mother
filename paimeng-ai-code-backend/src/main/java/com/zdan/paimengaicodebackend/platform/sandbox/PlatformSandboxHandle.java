package com.zdan.paimengaicodebackend.platform.sandbox;

/**
 * 一个已创建的 Sandbox 容器句柄（Issue #77 / T-05）。
 *
 * <p>不含 workspace 路径：AD-016 规定 workspace 为容器内 tmpfs，宿主机侧不存在对应路径。
 *
 * @param containerId   Docker 容器 ID
 * @param runId         归属 Run
 * @param applicationId 归属 Application
 */
public record PlatformSandboxHandle(
    String containerId,
    String runId,
    Long applicationId
) {
}
