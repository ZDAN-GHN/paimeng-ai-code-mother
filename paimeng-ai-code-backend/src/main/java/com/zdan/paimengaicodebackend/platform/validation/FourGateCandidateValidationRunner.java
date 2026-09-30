package com.zdan.paimengaicodebackend.platform.validation;

import com.zdan.paimengaicodebackend.platform.snapshot.SnapshotReference;
import org.springframework.stereotype.Component;

/** 生产实现：门禁结论完全来自 {@link CandidateFourGateExecutor}，本类不追加任何判断。 */
@Component
public class FourGateCandidateValidationRunner implements CandidateValidationGateRunner {

    private final CandidateFourGateExecutor executor;

    public FourGateCandidateValidationRunner(CandidateFourGateExecutor executor) {
        this.executor = executor;
    }

    @Override
    public CandidateFourGateExecutor.Report validate(SnapshotReference reference, String acceptanceTarget) {
        return executor.validate(reference, acceptanceTarget);
    }
}
