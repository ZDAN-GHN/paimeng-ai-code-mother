package com.zdan.paimengaicodebackend.platform.snapshot;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.CandidateSourceSnapshotMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.mapper.platform.ProfileDispositionMapper;
import com.zdan.paimengaicodebackend.mapper.platform.ValidationEvidenceMapper;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRun;
import com.zdan.paimengaicodebackend.platform.entity.ProfileDisposition;
import com.zdan.paimengaicodebackend.platform.entity.ValidationEvidence;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.Objects;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Persists legacy records separately from Platform validator-issued results. */
@Service
public class ValidationEvidenceService {
    private final CandidateSnapshotService snapshots;
    private final CandidateSourceSnapshotMapper snapshotMapper;
    private final PlatformRunMapper runs;
    private final ProfileDispositionMapper dispositions;
    private final ValidationEvidenceMapper evidence;
    private final ObjectMapper json;
    private final CandidateGitStore git;

    public ValidationEvidenceService(CandidateSnapshotService snapshots, CandidateSourceSnapshotMapper snapshotMapper,
                                     PlatformRunMapper runs, ProfileDispositionMapper dispositions,
                                     ValidationEvidenceMapper evidence, ObjectMapper json, CandidateGitStore git) {
        this.snapshots = snapshots;
        this.snapshotMapper = snapshotMapper;
        this.runs = runs;
        this.dispositions = dispositions;
        this.evidence = evidence;
        this.json = json;
        this.git = git;
    }

    @Transactional(rollbackFor = Exception.class)
    public ValidationEvidence record(SnapshotReference ref, String category, String result,
                                     String payloadJson, CandidateGitStore.ArtifactReference artifact,
                                     String idempotencyKey) {
        return recordInternal(ref, category, result, payloadJson, artifact, idempotencyKey, "LEGACY", "LEGACY");
    }

    @Transactional(rollbackFor = Exception.class)
    public ValidationEvidence recordValidated(SnapshotReference ref, String category, String result,
                                              String payloadJson, CandidateGitStore.ArtifactReference artifact,
                                              String attemptId) {
        if (attemptId == null || !attemptId.matches("[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
            || category == null || !List.of("ENGINEERING", "DATABASE", "RUNTIME", "TASK_ACCEPTANCE").contains(category)) {
            throw denied();
        }
        return recordInternal(ref, category, result, payloadJson, artifact, attemptId + ":" + category,
            "PLATFORM_VALIDATOR_V1", attemptId);
    }

    private ValidationEvidence recordInternal(SnapshotReference ref, String category, String result,
                                              String payloadJson, CandidateGitStore.ArtifactReference artifact,
                                              String idempotencyKey, String issuer, String attemptId) {
        if (ref == null || ref.runId() == null || snapshotMapper.lockRun(ref.runId()) == null) throw denied();
        PlatformRun run = runs.selectOneById(ref.runId());
        // A READY snapshot can survive a failed/expired Run; it is not sufficient for validation.
        if (run == null || !"SUCCEEDED".equals(run.getState())
            || !Objects.equals(run.getApplicationId(), ref.applicationId())
            || !Objects.equals(run.getTaskId(), ref.taskId())) throw denied();
        ref.require(snapshots);
        ProfileDisposition disposition = dispositions.selectOneById(ref.runId());
        boolean validDisposition = disposition != null && ProfileDispositionService.matches(disposition, ref);
        if (("LEGACY".equals(issuer) && !validDisposition)
            || ("PASS".equals(result) && (!validDisposition || "uncertain".equals(disposition.getDisposition())))) {
            throw denied();
        }
        if (category == null || !category.matches("[A-Z][A-Z0-9_]{0,63}")
            || !("PASS".equals(result) || "FAIL".equals(result) || "INCONCLUSIVE".equals(result))
            || idempotencyKey == null || idempotencyKey.isBlank() || idempotencyKey.length() > 64
            || artifact == null
            || payloadJson == null || payloadJson.getBytes(StandardCharsets.UTF_8).length > 65536) throw denied();
        byte[] payload;
        try (JsonParser parser = json.createParser(payloadJson)) {
            JsonNode parsed = json.readTree(parser);
            if (parsed == null || !(parsed.isObject() || parsed.isArray()) || parsed.isEmpty()
                || parser.nextToken() != null) throw denied();
            if (!"LEGACY".equals(issuer)
                && (parsed.size() != 4 || parsed.path("schemaVersion").asInt(-1) != 1
                    || !category.equals(parsed.path("category").asText(null))
                    || !result.equals(parsed.path("status").asText(null))
                    || !parsed.path("reasonCode").asText("").matches("[A-Z][A-Z0-9_]{0,63}"))) throw denied();
            payload = json.writeValueAsBytes(parsed);
        } catch (IOException e) {
            throw denied();
        }
        if (payload.length > 65536) throw denied();
        try {
            if ("LEGACY".equals(issuer)) git.verifyEvidence(ref, artifact);
            else if (!Arrays.equals(payload, git.readEvidence(ref, artifact))) throw denied();
        } catch (IOException e) {
            throw new BusinessException(ErrorCode.OPERATION_ERROR, "证据对象不可恢复", e);
        }
        String digest = sha256(payload);
        ValidationEvidence existing = evidence.selectOneByQuery(
            QueryWrapper.create().eq("runId", ref.runId()).eq("idempotencyKey", idempotencyKey));
        if (existing != null) {
            if (!matches(existing, ref) || !Objects.equals(existing.getCategory(), category)
                || !issuer.equals(existing.getIssuer()) || !attemptId.equals(existing.getAttemptId())
                || !Objects.equals(existing.getIdempotencyKey(), idempotencyKey)
                || !Objects.equals(existing.getResult(), result)
                || !Objects.equals(existing.getArtifactRef(), artifact.ref())
                || !Objects.equals(existing.getArtifactCommitHash(), artifact.commitHash())
                || !Objects.equals(existing.getArtifactSha256(), artifact.sha256())
                || !Objects.equals(existing.getPayloadSha256(), digest)
                || !sameJson(existing.getPayloadJson(), payload)) throw denied();
            return existing;
        }
        ValidationEvidence recorded = new ValidationEvidence();
        recorded.setApplicationId(ref.applicationId());
        recorded.setTaskId(ref.taskId());
        recorded.setRunId(ref.runId());
        recorded.setBaselineHash(ref.baselineHash());
        recorded.setBaseSourceRevision(ref.baseSourceRevision());
        recorded.setCommitHash(ref.commitHash());
        recorded.setTreeHash(ref.treeHash());
        recorded.setCategory(category);
        recorded.setResult(result);
        recorded.setPayloadJson(new String(payload, StandardCharsets.UTF_8));
        recorded.setPayloadSha256(digest);
        recorded.setArtifactRef(artifact.ref());
        recorded.setArtifactCommitHash(artifact.commitHash());
        recorded.setArtifactSha256(artifact.sha256());
        recorded.setIdempotencyKey(idempotencyKey);
        recorded.setIssuer(issuer);
        recorded.setAttemptId(attemptId);
        evidence.insert(recorded);
        return recorded;
    }

    private boolean sameJson(String saved, byte[] payload) {
        try {
            return json.readTree(saved).equals(json.readTree(new String(payload, StandardCharsets.UTF_8)));
        } catch (JsonProcessingException | IllegalArgumentException e) {
            return false;
        }
    }

    private static boolean matches(ValidationEvidence row, SnapshotReference ref) {
        return Objects.equals(row.getApplicationId(), ref.applicationId())
            && Objects.equals(row.getTaskId(), ref.taskId()) && Objects.equals(row.getRunId(), ref.runId())
            && Objects.equals(row.getBaselineHash(), ref.baselineHash())
            && Objects.equals(row.getBaseSourceRevision(), ref.baseSourceRevision())
            && Objects.equals(row.getCommitHash(), ref.commitHash())
            && Objects.equals(row.getTreeHash(), ref.treeHash());
    }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    private BusinessException denied() {
        return new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Validation 证据与可信 Snapshot 或 Run 不一致");
    }
}
