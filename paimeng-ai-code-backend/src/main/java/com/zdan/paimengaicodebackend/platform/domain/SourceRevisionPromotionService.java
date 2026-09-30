package com.zdan.paimengaicodebackend.platform.domain;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.AppMapper;
import com.zdan.paimengaicodebackend.mapper.platform.*;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.platform.entity.*;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateGitStore;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateSnapshotService;
import com.zdan.paimengaicodebackend.platform.snapshot.SnapshotReference;
import com.zdan.paimengaicodebackend.platform.validation.PlatformValidationQueueService;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Platform-only promotion entry point; no controller or external PASS claim is accepted. */
@Service
public class SourceRevisionPromotionService {
    private final AppMapper apps;
    private final PlatformTaskMapper tasks;
    private final PlatformRunMapper runs;
    private final CandidateSnapshotService snapshots;
    private final ProfileDispositionMapper dispositions;
    private final PlatformTrustedProfileVersionMapper profiles;
    private final PlatformRequirementMapper requirements;
    private final ValidationEvidenceMapper evidence;
    private final SourceRevisionMapper revisions;
    private final CandidateGitStore git;
    private final PlatformTaskTransitionService transitions;
    private final PlatformValidationQueueService validationQueue;
    private final ObjectMapper json;

    SourceRevisionPromotionService(AppMapper apps, PlatformTaskMapper tasks, PlatformRunMapper runs,
        CandidateSnapshotService snapshots, ProfileDispositionMapper dispositions,
        PlatformTrustedProfileVersionMapper profiles, PlatformRequirementMapper requirements,
        ValidationEvidenceMapper evidence, SourceRevisionMapper revisions, CandidateGitStore git,
        PlatformTaskTransitionService transitions, PlatformValidationQueueService validationQueue,
        ObjectMapper json) {
        this.apps = apps;
        this.tasks = tasks;
        this.runs = runs;
        this.snapshots = snapshots;
        this.dispositions = dispositions;
        this.profiles = profiles;
        this.requirements = requirements;
        this.evidence = evidence;
        this.revisions = revisions;
        this.git = git;
        this.transitions = transitions;
        this.validationQueue = validationQueue;
        this.json = json;
    }

    @Transactional(rollbackFor = Exception.class)
    public SourceRevision promote(SnapshotReference ref) {
        if (ref == null || ref.applicationId() <= 0 || ref.taskId() <= 0 || ref.runId() == null
            || ref.runId().isBlank() || apps.lockForPromotion(ref.applicationId()) == null) throw denied();
        App app = apps.selectOneById(ref.applicationId());
        if (app == null || !"ACTIVE".equals(app.getLifecycleStatus()) || !Objects.equals(app.getIsDelete(), 0)) {
            throw denied();
        }
        String attemptId = validationQueue.requirePassed(ref);
        SourceRevision existing = revisions.selectOneByQuery(QueryWrapper.create().eq("runId", ref.runId()));
        if (existing != null) {
            if (!sameIdentity(existing, ref) || !Objects.equals(app.getStableSourceRevision(), existing.getId())) {
                throw denied();
            }
            ref.require(snapshots);
            if (!attemptId.equals(existing.getValidationAttemptId())) throw denied();
            Map<String, ValidationEvidence> replayEvidence = requireEvidence(ref, attemptId);
            if (!Objects.equals(existing.getEngineeringEvidenceId(), replayEvidence.get("ENGINEERING").getId())
                || !Objects.equals(existing.getDatabaseEvidenceId(), replayEvidence.get("DATABASE").getId())
                || !Objects.equals(existing.getRuntimeEvidenceId(), replayEvidence.get("RUNTIME").getId())
                || !Objects.equals(existing.getTaskAcceptanceEvidenceId(), replayEvidence.get("TASK_ACCEPTANCE").getId())) {
                throw denied();
            }
            return existing;
        }
        PlatformTask task = tasks.selectOneById(ref.taskId());
        PlatformRun run = runs.selectOneById(ref.runId());
        if (task == null || run == null || !Objects.equals(task.getApplicationId(), ref.applicationId())
            || !Objects.equals(run.getApplicationId(), ref.applicationId())
            || !Objects.equals(run.getTaskId(), ref.taskId()) || !"SUCCEEDED".equals(run.getState())
            || !"EXECUTING".equals(task.getState()) || task.getBaselineJson() == null
            || !Objects.equals(CandidateGitStore.sha256(task.getBaselineJson()), ref.baselineHash())
            || !Objects.equals(task.getBaseSourceRevision(), ref.baseSourceRevision())
            || !Objects.equals(app.getStableSourceRevision(), task.getBaseSourceRevision())) throw denied();
        ref.require(snapshots);
        ProfileDisposition disposition = dispositions.selectOneById(ref.runId());
        if (disposition == null || !Objects.equals(disposition.getApplicationId(), ref.applicationId())
            || !Objects.equals(disposition.getTaskId(), ref.taskId())
            || !Objects.equals(disposition.getBaselineHash(), ref.baselineHash())
            || !Objects.equals(disposition.getBaseSourceRevision(), ref.baseSourceRevision())
            || !Objects.equals(disposition.getCommitHash(), ref.commitHash())
            || !Objects.equals(disposition.getTreeHash(), ref.treeHash())
            || disposition.getReason() == null || disposition.getReason().isBlank()) throw denied();

        Map<String, ValidationEvidence> passed = requireEvidence(ref, attemptId);
        PlatformTrustedProfileVersion base = task.getBaseProfileVersion() == null ? null
            : profiles.selectOneById(task.getBaseProfileVersion());
        if ((base == null && task.getBaseProfileVersion() != null)
            || (base != null && !Objects.equals(base.getApplicationId(), ref.applicationId()))) throw denied();
        if (ref.baseSourceRevision() != null) {
            SourceRevision parent = revisions.selectOneById(ref.baseSourceRevision());
            if (base == null || parent == null || !Objects.equals(parent.getApplicationId(), ref.applicationId())
                || !Objects.equals(parent.getProfileVersionId(), base.getId())) throw denied();
        }
        Long profileId = resolveProfile(ref, task, disposition, base);

        transitions.transition(ref.taskId(), PlatformTaskState.EXECUTING, PlatformTaskState.VALIDATED,
            PlatformActor.PLATFORM, new TaskTransitionConditions(false, false, false, false, false, false, true),
            "SNAPSHOT_VALIDATED", ref.commitHash(), "promotion:" + ref.runId());
        SourceRevision revision = new SourceRevision();
        revision.setId(UUID.randomUUID().toString());
        revision.setApplicationId(ref.applicationId());
        revision.setTaskId(ref.taskId());
        revision.setRunId(ref.runId());
        revision.setBaselineHash(ref.baselineHash());
        revision.setBaseSourceRevision(ref.baseSourceRevision());
        revision.setCommitHash(ref.commitHash());
        revision.setTreeHash(ref.treeHash());
        revision.setProfileVersionId(profileId);
        revision.setEngineeringEvidenceId(passed.get("ENGINEERING").getId());
        revision.setDatabaseEvidenceId(passed.get("DATABASE").getId());
        revision.setRuntimeEvidenceId(passed.get("RUNTIME").getId());
        revision.setTaskAcceptanceEvidenceId(passed.get("TASK_ACCEPTANCE").getId());
        revision.setValidationAttemptId(attemptId);
        if (revisions.insert(revision) != 1) throw denied();
        App update = new App();
        update.setStableSourceRevision(revision.getId());
        QueryWrapper condition = QueryWrapper.create().eq("id", ref.applicationId());
        if (ref.baseSourceRevision() == null) condition.isNull("stableSourceRevision");
        else condition.eq("stableSourceRevision", ref.baseSourceRevision());
        if (apps.updateByQuery(update, true, condition) != 1) throw denied();
        return revision;
    }

    private Long resolveProfile(SnapshotReference ref, PlatformTask task, ProfileDisposition disposition,
        PlatformTrustedProfileVersion base) {
        if ("unchanged".equals(disposition.getDisposition())) {
            if (base == null || disposition.getDiffJson() != null || disposition.getRequirementId() != null) throw denied();
            return base.getId();
        }
        if (!"changed".equals(disposition.getDisposition()) || disposition.getRequirementId() == null) throw denied();
        PlatformRequirement requirement = requirements.selectOneById(disposition.getRequirementId());
        if (requirement == null || !Objects.equals(requirement.getApplicationId(), ref.applicationId())
            || !Objects.equals(requirement.getId(), task.getRequirementId())) throw denied();
        try {
            JsonNode diff = json.readTree(disposition.getDiffJson());
            if (diff == null || !diff.isObject() || !diff.path("candidateProfile").isObject()
                || diff.path("candidateProfile").isEmpty() || !diff.path("changes").isArray()
                || diff.path("changes").isEmpty()) throw denied();
            PlatformTrustedProfileVersion latest = profiles.selectOneByQuery(QueryWrapper.create()
                .eq("appId", ref.applicationId()).orderBy("versionNumber", false).limit(1));
            if (latest != null && latest.getVersionNumber() == null) throw denied();
            if ((base == null && latest != null)
                || (base != null && (base.getVersionNumber() == null || latest == null
                    || !Objects.equals(latest.getId(), base.getId())))) throw denied();
            long next = latest == null ? 1 : Math.addExact(latest.getVersionNumber(), 1);
            PlatformTrustedProfileVersion promoted = new PlatformTrustedProfileVersion();
            promoted.setApplicationId(ref.applicationId());
            promoted.setVersionNumber(next);
            promoted.setProfileJson(json.writeValueAsString(diff.get("candidateProfile")));
            if (profiles.insert(promoted) != 1 || promoted.getId() == null) throw denied();
            return promoted.getId();
        } catch (IOException | ArithmeticException e) {
            throw denied();
        }
    }

    private Map<String, ValidationEvidence> requireEvidence(SnapshotReference ref, String attemptId) {
        Map<String, ValidationEvidence> accepted = new HashMap<>();
        List<ValidationEvidence> rows = evidence.selectListByQuery(QueryWrapper.create().eq("runId", ref.runId()));
        if (rows == null) throw denied();
        for (ValidationEvidence row : rows) {
            if (!List.of("ENGINEERING", "DATABASE", "RUNTIME", "TASK_ACCEPTANCE").contains(row.getCategory())) continue;
            if (!attemptId.equals(row.getAttemptId())) continue;
            if (row.getId() == null || !"PASS".equals(row.getResult())
                || !"PLATFORM_VALIDATOR_V1".equals(row.getIssuer())
                || !Objects.equals(row.getIdempotencyKey(), attemptId + ":" + row.getCategory())
                || !Objects.equals(row.getApplicationId(), ref.applicationId())
                || !Objects.equals(row.getTaskId(), ref.taskId())
                || !Objects.equals(row.getBaselineHash(), ref.baselineHash())
                || !Objects.equals(row.getBaseSourceRevision(), ref.baseSourceRevision())
                || !Objects.equals(row.getCommitHash(), ref.commitHash())
                || !Objects.equals(row.getTreeHash(), ref.treeHash())
                || accepted.putIfAbsent(row.getCategory(), row) != null) throw denied();
            try {
                byte[] verified = git.readEvidence(ref, new CandidateGitStore.ArtifactReference(
                    row.getArtifactRef(), row.getArtifactCommitHash(), row.getArtifactSha256()));
                if (!Arrays.equals(verified, row.getPayloadJson().getBytes(StandardCharsets.UTF_8))) throw denied();
            } catch (IOException e) {
                throw new BusinessException(ErrorCode.OPERATION_ERROR, "Validation 证据不可恢复", e);
            }
        }
        if (accepted.size() != 4) throw denied();
        return accepted;
    }

    private boolean sameIdentity(SourceRevision row, SnapshotReference ref) {
        return Objects.equals(row.getApplicationId(), ref.applicationId())
            && Objects.equals(row.getTaskId(), ref.taskId())
            && Objects.equals(row.getRunId(), ref.runId())
            && Objects.equals(row.getBaselineHash(), ref.baselineHash())
            && Objects.equals(row.getBaseSourceRevision(), ref.baseSourceRevision())
            && Objects.equals(row.getCommitHash(), ref.commitHash())
            && Objects.equals(row.getTreeHash(), ref.treeHash());
    }

    private BusinessException denied() {
        return new BusinessException(ErrorCode.FORBIDDEN_ERROR, "SourceRevision 晋升条件不满足");
    }
}
