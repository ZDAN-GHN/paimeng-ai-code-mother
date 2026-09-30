package com.zdan.paimengaicodebackend.platform.validation;

import com.zdan.paimengaicodebackend.platform.snapshot.SnapshotReference;

/**
 * 候选版本门禁执行器（Issue #80 / T-08）
 *
 * <p>抽成接口只有一个理由：门禁执行需要 Docker 与隔离 MySQL，而「验证结论如何改变
 * Task 状态」必须在没有这些外部依赖的情况下被测试。生产实现委托给
 * {@link CandidateFourGateExecutor}，测试可以替换为确定性桩。
 */
public interface CandidateValidationGateRunner {

    CandidateFourGateExecutor.Report validate(SnapshotReference reference, String acceptanceTarget);
}
