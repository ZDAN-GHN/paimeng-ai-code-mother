package com.zdan.paimengaicodebackend.platform.snapshot;

import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.CandidateSourceSnapshotMapper;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunLeaseService;
import com.zdan.paimengaicodebackend.platform.entity.CandidateSourceSnapshot;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import java.util.Objects;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Serialize the freeze claim against command admission with the Run row lock. */
@Service
public class SnapshotClaims {
    private final CandidateSourceSnapshotMapper mapper;
    private final PlatformRunLeaseService leaseService;

    public SnapshotClaims(CandidateSourceSnapshotMapper mapper, PlatformRunLeaseService leaseService) {
        this.mapper = mapper;
        this.leaseService = leaseService;
    }

    @Transactional(rollbackFor = Exception.class)
    public CandidateSourceSnapshot claim(long appId, String runId, long fence, String requestId,
                                         PlatformTask task, String baselineHash) {
        if (mapper.lockRun(runId) == null) throw denied();
        leaseService.requireHeldLease(runId, fence, requestId);
        CandidateSourceSnapshot snapshot = mapper.selectOneById(runId);
        if (snapshot == null) {
            if (mapper.countUnfinishedCommands(runId) != 0) throw denied();
            snapshot = new CandidateSourceSnapshot();
            snapshot.setRunId(runId);
            snapshot.setApplicationId(appId);
            snapshot.setTaskId(task.getId());
            snapshot.setRequestId(requestId);
            snapshot.setFenceToken(fence);
            snapshot.setBaselineHash(baselineHash);
            snapshot.setBaseSourceRevision(task.getBaseSourceRevision());
            snapshot.setStatus("FREEZING");
            mapper.insert(snapshot);
        } else {
            if (!Objects.equals(snapshot.getApplicationId(), appId)
                || !Objects.equals(snapshot.getTaskId(), task.getId())
                || !Objects.equals(snapshot.getBaselineHash(), baselineHash)
                || !Objects.equals(snapshot.getBaseSourceRevision(), task.getBaseSourceRevision())) throw denied();
            if ("READY".equals(snapshot.getStatus())) {
                if (!Objects.equals(snapshot.getRequestId(), requestId)
                    || !Objects.equals(snapshot.getFenceToken(), fence)) throw denied();
                return snapshot;
            }
            if (!("ABORTED".equals(snapshot.getStatus())
                || ("FREEZING".equals(snapshot.getStatus())
                    && !Objects.equals(snapshot.getFenceToken(), fence)))
                || mapper.countUnfinishedCommands(runId) != 0) throw denied();
            CandidateSourceSnapshot replacement = new CandidateSourceSnapshot();
            replacement.setRequestId(requestId);
            replacement.setFenceToken(fence);
            replacement.setStatus("FREEZING");
            if (mapper.updateByQuery(replacement, true, QueryWrapper.create()
                .eq("runId", runId).eq("status", snapshot.getStatus())
                .eq("requestId", snapshot.getRequestId())
                .eq("fenceToken", snapshot.getFenceToken())) != 1) throw denied();
            snapshot.setRequestId(requestId);
            snapshot.setFenceToken(fence);
            snapshot.setStatus("FREEZING");
        }
        return snapshot;
    }

    @Transactional(rollbackFor = Exception.class)
    public void abort(CandidateSourceSnapshot claim) {
        if (mapper.lockRun(claim.getRunId()) == null) throw denied();
        CandidateSourceSnapshot existing = mapper.selectOneById(claim.getRunId());
        if (existing == null || !"FREEZING".equals(existing.getStatus())
            || !Objects.equals(existing.getRequestId(), claim.getRequestId())
            || !Objects.equals(existing.getFenceToken(), claim.getFenceToken())) return;
        CandidateSourceSnapshot aborted = new CandidateSourceSnapshot();
        aborted.setStatus("ABORTED");
        if (mapper.updateByQuery(aborted, true, QueryWrapper.create()
            .eq("runId", claim.getRunId()).eq("requestId", claim.getRequestId())
            .eq("fenceToken", claim.getFenceToken()).eq("status", "FREEZING")) != 1) throw denied();
    }

    @Transactional(rollbackFor = Exception.class)
    public void finish(CandidateSourceSnapshot snapshot, String commit, String tree) {
        if (mapper.lockRun(snapshot.getRunId()) == null) throw denied();
        leaseService.requireHeldLeaseForSnapshotPublication(
            snapshot.getRunId(), snapshot.getFenceToken(), snapshot.getRequestId());
        CandidateSourceSnapshot existing = mapper.selectOneById(snapshot.getRunId());
        if (existing == null || !"FREEZING".equals(existing.getStatus())
            || !Objects.equals(existing.getRequestId(), snapshot.getRequestId())
            || !Objects.equals(existing.getFenceToken(), snapshot.getFenceToken())) throw denied();
        CandidateSourceSnapshot updated = new CandidateSourceSnapshot();
        updated.setStatus("READY");
        updated.setCommitHash(commit);
        updated.setTreeHash(tree);
        if (mapper.updateByQuery(updated, true, QueryWrapper.create()
            .eq("runId", snapshot.getRunId()).eq("requestId", snapshot.getRequestId())
            .eq("fenceToken", snapshot.getFenceToken()).eq("status", "FREEZING")) != 1) throw denied();
    }

    private BusinessException denied() {
        return new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Snapshot 冻结状态或 fence 已变化");
    }
}
