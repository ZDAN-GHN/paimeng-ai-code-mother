package com.zdan.paimengaicodebackend.model.dto.run;

import lombok.Data;

import java.io.Serial;
import java.io.Serializable;
import java.time.LocalDateTime;

/**
 * 创建生成运行（generation_run）请求（Java 内部 API，由 TS Agent 调用）
 *
 * @author LXH
 */
@Data
public class RunCreateRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;

    /**
     * 运行 id（幂等键，复用现有 runId 语义；同 runId 重复创建返回既有 run）
     */
    private String runId;

    /**
     * 应用 id
     */
    private Long appId;

    /**
     * 创建用户 id
     */
    private Long userId;

    /**
     * 初始阶段（interview 等，见 GenerationRunPhaseEnum）
     */
    private String phase;

    /**
     * 运行上下文 JSON（可空）
     */
    private String context;

    /**
     * 已过里程碑列表 JSON（可空）
     */
    private String milestones;

    /**
     * token 计量 JSON（可空）
     */
    private String tokenUsage;

    /**
     * 积分台账引用（可空，预留）
     */
    private String creditLedgerRef;

    /**
     * 开始时间（可空，默认取当前时间）
     */
    private LocalDateTime startedTime;
}
