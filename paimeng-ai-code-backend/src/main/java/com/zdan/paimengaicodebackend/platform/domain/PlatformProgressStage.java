package com.zdan.paimengaicodebackend.platform.domain;

/**
 * Owner 安全的执行阶段（Issue #80 / T-08）
 * <p>
 * Agent 的原始 {@code AgentExecutionEvent} 带工具名与增量文本，既不适合落库也不适合
 * 展示给 Owner。Runtime 只把这些事件聚合成这里的一个粗粒度阶段，Platform 再投影出去。
 */
public enum PlatformProgressStage {

    NORMALIZING("正在理解你的需求"),
    NORMALIZATION_BLOCKED("已暂停，等待你的确认"),
    EXECUTING("正在构建你的 Application"),
    VALIDATING("正在验证构建结果"),
    VALIDATION_FAILED("验证未通过");

    private final String note;

    PlatformProgressStage(String note) {
        this.note = note;
    }

    public String note() {
        return note;
    }
}
