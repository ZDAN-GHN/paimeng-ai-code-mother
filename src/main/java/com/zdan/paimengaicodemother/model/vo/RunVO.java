package com.zdan.paimengaicodemother.model.vo;

import lombok.Data;

import java.io.Serial;
import java.io.Serializable;
import java.time.LocalDateTime;

/**
 * 生成运行（generation_run）视图对象
 *
 * @author LXH
 */
@Data
public class RunVO implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;

    /**
     * 运行 id
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
     * 运行阶段（显式枚举值，见 GenerationRunPhaseEnum）
     */
    private String phase;

    /**
     * 运行上下文 JSON
     */
    private String context;

    /**
     * 已过里程碑列表 JSON
     */
    private String milestones;

    /**
     * token 计量 JSON
     */
    private String tokenUsage;

    /**
     * 积分台账引用
     */
    private String creditLedgerRef;

    /**
     * 开始时间
     */
    private LocalDateTime startedTime;

    /**
     * 结束时间
     */
    private LocalDateTime finishedTime;

    /**
     * 创建时间
     */
    private LocalDateTime createTime;

    /**
     * 更新时间
     */
    private LocalDateTime updateTime;
}
