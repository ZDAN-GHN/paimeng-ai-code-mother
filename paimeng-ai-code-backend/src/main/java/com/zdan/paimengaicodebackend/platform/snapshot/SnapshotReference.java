package com.zdan.paimengaicodebackend.platform.snapshot;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.platform.entity.CandidateSourceSnapshot;
import java.util.Objects;

/** Immutable identity supplied by an internal caller, checked against the persisted Git-backed Snapshot. */
public record SnapshotReference(long applicationId, long taskId, String runId, String baselineHash,
                                String baseSourceRevision, String commitHash, String treeHash) {
    public CandidateSourceSnapshot require(CandidateSnapshotService snapshots) {
        CandidateSourceSnapshot snapshot = snapshots.requireReady(applicationId, runId);
        if (!Objects.equals(snapshot.getTaskId(), taskId)
            || !Objects.equals(snapshot.getBaselineHash(), baselineHash)
            || !Objects.equals(snapshot.getBaseSourceRevision(), baseSourceRevision)
            || !Objects.equals(snapshot.getCommitHash(), commitHash)
            || !Objects.equals(snapshot.getTreeHash(), treeHash)) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Snapshot 引用不一致");
        }
        return snapshot;
    }
}
