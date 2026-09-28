package com.zdan.paimengaicodebackend.platform.snapshot;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.CandidateSourceSnapshotMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRequirementMapper;
import com.zdan.paimengaicodebackend.mapper.platform.ProfileDispositionMapper;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRequirement;
import com.zdan.paimengaicodebackend.platform.entity.ProfileDisposition;
import java.nio.charset.StandardCharsets;
import java.util.Objects;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Internal disposition recorder; it does not infer whether a profile actually changed. */
@Service
public class ProfileDispositionService {
    private final CandidateSnapshotService snapshots;
    private final CandidateSourceSnapshotMapper snapshotMapper;
    private final PlatformRequirementMapper requirements;
    private final ProfileDispositionMapper dispositions;
    private final ObjectMapper json;

    public ProfileDispositionService(CandidateSnapshotService snapshots, CandidateSourceSnapshotMapper snapshotMapper,
                                     PlatformRequirementMapper requirements, ProfileDispositionMapper dispositions,
                                     ObjectMapper json) {
        this.snapshots = snapshots;
        this.snapshotMapper = snapshotMapper;
        this.requirements = requirements;
        this.dispositions = dispositions;
        this.json = json;
    }

    @Transactional(rollbackFor = Exception.class)
    public ProfileDisposition record(SnapshotReference ref, String disposition, String diffJson,
                                     Long requirementId, String reason) {
        if (ref == null || ref.runId() == null || snapshotMapper.lockRun(ref.runId()) == null) throw denied();
        ref.require(snapshots);
        if (reason == null || reason.isBlank() || reason.length() > 2048) throw denied();
        String normalizedReason = reason.trim();
        String normalizedDiff = null;
        switch (disposition == null ? "" : disposition) {
            case "changed" -> {
                if (requirementId == null || requirementId <= 0) throw denied();
                PlatformRequirement requirement = requirements.selectOneById(requirementId);
                if (requirement == null || !Objects.equals(requirement.getApplicationId(), ref.applicationId())) {
                    throw denied();
                }
                if (diffJson == null || diffJson.getBytes(StandardCharsets.UTF_8).length > 65536) throw denied();
                try {
                    JsonNode diff = json.readTree(diffJson);
                    if (diff == null || !(diff.isObject() || diff.isArray()) || diff.isEmpty()) throw denied();
                    normalizedDiff = json.writeValueAsString(diff);
                } catch (JsonProcessingException e) {
                    throw denied();
                }
            }
            case "unchanged", "uncertain" -> {
                if (diffJson != null || requirementId != null) throw denied();
            }
            default -> throw denied();
        }
        ProfileDisposition existing = dispositions.selectOneById(ref.runId());
        if (existing != null) {
            if (!matches(existing, ref) || !Objects.equals(existing.getDisposition(), disposition)
                || !Objects.equals(existing.getDiffJson(), normalizedDiff)
                || !Objects.equals(existing.getRequirementId(), requirementId)
                || !Objects.equals(existing.getReason(), normalizedReason)) throw denied();
            return existing;
        }
        ProfileDisposition recorded = new ProfileDisposition();
        recorded.setRunId(ref.runId());
        recorded.setApplicationId(ref.applicationId());
        recorded.setTaskId(ref.taskId());
        recorded.setBaselineHash(ref.baselineHash());
        recorded.setBaseSourceRevision(ref.baseSourceRevision());
        recorded.setCommitHash(ref.commitHash());
        recorded.setTreeHash(ref.treeHash());
        recorded.setDisposition(disposition);
        recorded.setDiffJson(normalizedDiff);
        recorded.setRequirementId(requirementId);
        recorded.setReason(normalizedReason);
        dispositions.insert(recorded);
        return recorded;
    }

    static boolean matches(ProfileDisposition row, SnapshotReference ref) {
        return Objects.equals(row.getApplicationId(), ref.applicationId())
            && Objects.equals(row.getTaskId(), ref.taskId()) && Objects.equals(row.getRunId(), ref.runId())
            && Objects.equals(row.getBaselineHash(), ref.baselineHash())
            && Objects.equals(row.getBaseSourceRevision(), ref.baseSourceRevision())
            && Objects.equals(row.getCommitHash(), ref.commitHash())
            && Objects.equals(row.getTreeHash(), ref.treeHash());
    }

    private BusinessException denied() {
        return new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Profile 处置与可信 Snapshot 不一致");
    }
}
