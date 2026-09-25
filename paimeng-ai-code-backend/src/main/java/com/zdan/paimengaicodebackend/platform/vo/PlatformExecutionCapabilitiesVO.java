package com.zdan.paimengaicodebackend.platform.vo;

import io.swagger.v3.oas.annotations.media.Schema;
import java.util.List;
import lombok.Data;

/**
 * 受控执行环境的真实能力（Issue #77 / T-05）。
 *
 * <p>AD-016：只有 Platform 受控执行器掌握隔离后端的真实能力，因此本对象一律由 Java 侧
 * 依据实际配置组装，Runtime 不得自行推断或硬编码。
 *
 * <p>{@code schemaVersion} 精确匹配即兼容：Runtime 读到非预期版本应拒绝执行而非猜测语义。
 */
@Data
@Schema(description = "受控执行环境能力（由 Platform 组装）")
public class PlatformExecutionCapabilitiesVO {

    /** 当前契约版本。字段语义变更必须同时递增该值。 */
    public static final String CURRENT_SCHEMA_VERSION = "1";

    @Schema(description = "契约版本；精确匹配即兼容", example = "1")
    private String schemaVersion = CURRENT_SCHEMA_VERSION;

    @Schema(description = "容器内工作目录", example = "/workspace")
    private String workspacePath;

    @Schema(
        description = "Workspace 是否跨容器留存。tmpfs 实现下为 false：容器删除即消失，"
            + "需留存的事实由 Platform 在受信任边界提取",
        example = "false"
    )
    private boolean workspacePersistent;

    @Schema(description = "容器内可写路径；此外的写入会被只读根文件系统拒绝")
    private List<String> writablePaths;

    @Schema(description = "是否具备网络访问能力。无网络命名空间下为 false", example = "false")
    private boolean networkAccessAvailable;

    @Schema(description = "根文件系统是否只读", example = "true")
    private boolean readonlyRootFilesystem;

    @Schema(description = "内存限额 MiB", example = "4096")
    private long memoryLimitMb;

    @Schema(description = "CPU 限额（vCPU）", example = "2.0")
    private double cpuLimit;

    @Schema(description = "进程数限额", example = "256")
    private long pidsLimit;

    @Schema(description = "Workspace tmpfs 容量 MiB", example = "2048")
    private long workspaceTmpfsSizeMb;

    @Schema(description = "/tmp tmpfs 容量 MiB", example = "512")
    private long tmpfsSizeMb;

    @Schema(description = "Lease 存活秒数", example = "60")
    private long leaseTtlSeconds;

    @Schema(description = "建议续租间隔秒数；服务端不强制", example = "20")
    private long leaseRenewIntervalSeconds;

    @Schema(description = "单个 Lease 最大续租次数", example = "3")
    private int leaseMaxRenewCount;

    @Schema(description = "命令默认超时秒数", example = "300")
    private int defaultCommandTimeoutSeconds;

    @Schema(description = "命令超时上限秒数；请求超过该值即被拒绝", example = "900")
    private int maxCommandTimeoutSeconds;
}
