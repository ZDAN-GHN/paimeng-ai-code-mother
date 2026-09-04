package com.zdan.paimengaicodemother.model.dto.run;

import lombok.Data;

import java.io.Serial;
import java.io.Serializable;
import java.time.LocalDateTime;

/**
 * 更新生成运行（generation_run）请求（Java 内部 API，按 runId 推进 phase/上下文/里程碑/计量）
 * 仅更新非空字段；全部为空等同幂等更新（无副作用）。
 *
 * @author LXH
 */
@Data
public class RunUpdateRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;

    /**
     * 推进到的阶段（可空）
     */
    private String phase;

    /**
     * 运行上下文 JSON（可空，整体覆盖）
     */
    private String context;

    /**
     * 已过里程碑列表 JSON（可空，整体覆盖）
     */
    private String milestones;

    /**
     * token 计量 JSON（可空，整体覆盖）
     */
    private String tokenUsage;

    /**
     * 积分台账引用（可空）
     */
    private String creditLedgerRef;

    /**
     * 结束时间（可空；进入终态未显式传入时由服务端取当前时间）
     */
    private LocalDateTime finishedTime;
}
