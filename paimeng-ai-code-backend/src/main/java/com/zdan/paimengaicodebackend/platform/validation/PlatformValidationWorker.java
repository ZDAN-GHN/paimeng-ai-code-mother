package com.zdan.paimengaicodebackend.platform.validation;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.platform.domain.PlatformProgressStage;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunProgressService;
import com.zdan.paimengaicodebackend.platform.domain.PlatformTaskLifecycleService;
import com.zdan.paimengaicodebackend.platform.domain.SourceRevisionPromotionService;
import com.zdan.paimengaicodebackend.platform.entity.CandidateSourceSnapshot;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRun;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import com.zdan.paimengaicodebackend.platform.entity.ProfileDisposition;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateGitStore;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateSnapshotService;
import com.zdan.paimengaicodebackend.platform.snapshot.SnapshotReference;
import com.zdan.paimengaicodebackend.platform.snapshot.ValidationEvidenceService;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Optional;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

/**
 * 权威验证的驱动方（Issue #80 / T-08）
 *
 * <p>AD-009：开发完成由 Platform 的验证裁决，不由 Agent 自述决定。这里是唯一把
 * 「Run 成功」推进到「Task 通过验证」或「Task 失败」的地方：
 *
 * <ul>
 *   <li>四类门禁必须全部 {@code PASS}，且 Snapshot 里的 Profile 申报不是
 *       {@code uncertain}，才允许写入 {@code PASS} 并进入唯一的晋升路径；</li>
 *   <li>任何一门禁未通过、Profile 申报不完整或证据链无法闭合，都不晋升，
 *       并把 Task 落到 {@code failed} 且保留冻结基线；</li>
 *   <li>Agent 文本、Workspace 内容或调用方自称的通过都不构成证据：证据只经
 *       {@link ValidationEvidenceService#recordValidated} 写入，且必须绑定同一
 *       Snapshot 与同一 Platform 尝试。</li>
 * </ul>
 */
@Slf4j
@Service
public class PlatformValidationWorker {

    /** 一次验证结算的对外结果；不暴露内部 Claim 类型。 */
    public record Outcome(String runId, String state, String reasonCode) { }

    /**
     * 与 {@code CandidateFourGateExecutor.Report#gates()} 的声明顺序一一对应。
     *
     * <p>顺序即契约：晋升闸门按 category 统计四类 PASS Evidence，类别错位会让验证
     * 通过却无法晋升，或反过来。
     */
    private static final List<String> GATE_CATEGORIES =
        List.of("ENGINEERING", "DATABASE", "RUNTIME", "TASK_ACCEPTANCE");

    private final PlatformValidationQueueService validationQueue;
    private final SnapshotProfileDeclarationService profileDeclarations;
    private final CandidateSnapshotService snapshots;
    private final CandidateValidationGateRunner gateRunner;
    private final ValidationEvidenceService evidenceService;
    private final CandidateGitStore git;
    private final SourceRevisionPromotionService promotion;
    private final PlatformTaskLifecycleService lifecycle;
    private final PlatformRunProgressService progress;
    private final PlatformRunMapper runMapper;
    private final PlatformTaskMapper taskMapper;

    public PlatformValidationWorker(
        PlatformValidationQueueService validationQueue,
        SnapshotProfileDeclarationService profileDeclarations,
        CandidateSnapshotService snapshots,
        CandidateValidationGateRunner gateRunner,
        ValidationEvidenceService evidenceService,
        CandidateGitStore git,
        SourceRevisionPromotionService promotion,
        PlatformTaskLifecycleService lifecycle,
        PlatformRunProgressService progress,
        PlatformRunMapper runMapper,
        PlatformTaskMapper taskMapper
    ) {
        this.validationQueue = validationQueue;
        this.profileDeclarations = profileDeclarations;
        this.snapshots = snapshots;
        this.gateRunner = gateRunner;
        this.evidenceService = evidenceService;
        this.git = git;
        this.promotion = promotion;
        this.lifecycle = lifecycle;
        this.progress = progress;
        this.runMapper = runMapper;
        this.taskMapper = taskMapper;
    }

    /**
     * 领取并结算一条验证请求。
     *
     * @return 队列为空时返回 {@link Optional#empty()}；这不是错误，只是暂时没有待验证 Run
     */
    public Optional<Outcome> settleNext() {
        Optional<PlatformValidationQueueService.Claim> claimed = validationQueue.claimNext();
        if (claimed.isEmpty()) {
            return Optional.empty();
        }
        PlatformValidationQueueService.Claim claim = claimed.get();
        PlatformRun run = runMapper.selectOneById(claim.runId());
        if (run == null) {
            validationQueue.complete(claim, "INCONCLUSIVE", "RUN_NOT_FOUND");
            reportUnlocatableTask(claim, "RUN_NOT_FOUND");
            return Optional.of(new Outcome(claim.runId(), "INCONCLUSIVE", "RUN_NOT_FOUND"));
        }
        PlatformTask task = taskMapper.selectOneById(run.getTaskId());
        if (task == null) {
            validationQueue.complete(claim, "INCONCLUSIVE", "TASK_NOT_FOUND");
            reportUnlocatableTask(claim, "TASK_NOT_FOUND");
            return Optional.of(new Outcome(claim.runId(), "INCONCLUSIVE", "TASK_NOT_FOUND"));
        }
        if (task.getAcceptanceTarget() == null || task.getAcceptanceTarget().isBlank()) {
            // Task 还在，就能且必须把它落回 failed：否则 Owner 会永远停在「正在构建」。
            validationQueue.complete(claim, "INCONCLUSIVE", "ACCEPTANCE_TARGET_MISSING");
            failTask(run, task, "VALIDATION_INCONCLUSIVE", "ACCEPTANCE_TARGET_MISSING");
            return Optional.of(new Outcome(claim.runId(), "INCONCLUSIVE", "ACCEPTANCE_TARGET_MISSING"));
        }
        progress.record(run.getApplicationId(), task.getId(), run.getId(), PlatformProgressStage.VALIDATING, null);
        try {
            return Optional.of(evaluate(claim, run, task));
        } catch (BusinessException | IOException incomplete) {
            // 证据链不完整时不允许留下任何 PASS 痕迹：结论是「无法验证」，不是「通过」。
            // 原因必须留痕：把它归成 INCONCLUSIVE 已经掩盖了失败模式，再不记日志就只剩
            // 一个笼统的结论，任何真实缺陷都无法从测试输出里被发现。
            log.error(
                "Platform validation evidence chain is incomplete, runId: {}, applicationId: {}, result: failure",
                claim.runId(), claim.applicationId(), incomplete);
            validationQueue.complete(claim, "INCONCLUSIVE", "EVIDENCE_CHAIN_INCOMPLETE");
            failTask(run, task, "VALIDATION_INCONCLUSIVE", "EVIDENCE_CHAIN_INCOMPLETE");
            return Optional.of(new Outcome(claim.runId(), "INCONCLUSIVE", "EVIDENCE_CHAIN_INCOMPLETE"));
        }
    }

    private Outcome evaluate(PlatformValidationQueueService.Claim claim, PlatformRun run, PlatformTask task)
        throws IOException {
        SnapshotReference reference = referenceFor(run, task);
        ProfileDisposition disposition = profileDeclarations.declare(reference);
        boolean profileSettled = !"uncertain".equals(disposition.getDisposition());
        List<CandidateFourGateExecutor.Gate> gates = gateRunner.validate(reference, task.getAcceptanceTarget()).gates();
        if (gates.size() != GATE_CATEGORIES.size()) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "验证门禁数量与契约不一致");
        }

        boolean allPassed = profileSettled;
        String firstFailure = profileSettled ? null : "PROFILE_DISPOSITION_UNCERTAIN";
        for (int index = 0; index < gates.size(); index++) {
            CandidateFourGateExecutor.Gate gate = gates.get(index);
            String category = GATE_CATEGORIES.get(index);
            String result = gate.passed() && profileSettled
                ? "PASS"
                : (gate.passed() ? "INCONCLUSIVE" : "FAIL");
            recordEvidence(reference, claim.attemptId(), category, gate, result);
            if (!"PASS".equals(result) && firstFailure == null) {
                allPassed = false;
                firstFailure = gate.reasonCode();
            }
        }

        if (!allPassed) {
            validationQueue.complete(claim, "FAIL", firstFailure);
            failTask(run, task, "VALIDATION_FAILED", firstFailure);
            return new Outcome(claim.runId(), "FAIL", firstFailure);
        }
        validationQueue.complete(claim, "PASS", "ALL_GATES_PASSED");
        promotion.promote(reference);
        return new Outcome(claim.runId(), "PASS", "ALL_GATES_PASSED");
    }

    private void recordEvidence(
        SnapshotReference reference,
        String attemptId,
        String category,
        CandidateFourGateExecutor.Gate gate,
        String result
    ) throws IOException {
        // 证据载荷必须是 {schemaVersion, category, status, reasonCode} 四键对象，而且落盘字节
        // 必须与登记的 JSON 逐字节一致——记录时会重新读回 artifact 比对，对不上就整条拒绝。
        // 因此这里只拼一次，既写入 artifact 也交给登记方。
        String payload = "{\"schemaVersion\":1,\"category\":\"" + category
            + "\",\"status\":\"" + result
            + "\",\"reasonCode\":\"" + gate.reasonCode() + "\"}";
        CandidateGitStore.ArtifactReference artifact = git.persistEvidence(
            reference, category.toLowerCase(), payload.getBytes(StandardCharsets.UTF_8));
        evidenceService.recordValidated(reference, category, result, payload, artifact, attemptId);
    }

    private void failTask(PlatformRun run, PlatformTask task, String failureCode, String reasonCode) {
        String snapshotCommit = snapshots.requireReady(run.getApplicationId(), run.getId()).getCommitHash();
        // requestId 就是幂等键，列宽 64：真实 runId 已有 40 字符（run- + UUID），再拼
        // 失败原因会超长。用 runId 本身即可——同一个 Run 至多失败一次。
        lifecycle.markFailed(task.getId(), failureCode, reasonCode, snapshotCommit, run.getId());
        progress.record(run.getApplicationId(), task.getId(), run.getId(),
            PlatformProgressStage.VALIDATION_FAILED, null);
    }

    /**
     * Run 已不存在时没有 Snapshot 可引用。
     *
     * <p>这时也无法定位 Task：验证队列的 Claim 不带 taskId，而唯一能反查它的 Run 行已经没了。
     * 因此只结算队列并留下错误日志——这类缺失是数据完整性问题，不是验证结论，
     * 按推测把它算成「验证未通过」等于在没有 Task 的情况下改状态。
     */
    private void reportUnlocatableTask(PlatformValidationQueueService.Claim claim, String reasonCode) {
        log.error(
            "Platform validation cannot settle a Task state, runId: {}, applicationId: {}, reasonCode: {}",
            claim.runId(), claim.applicationId(), reasonCode);
    }

    private SnapshotReference referenceFor(PlatformRun run, PlatformTask task) {
        CandidateSourceSnapshot snapshot = snapshots.requireReady(run.getApplicationId(), run.getId());
        if (!task.getId().equals(snapshot.getTaskId())) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Snapshot 与 Task 不一致");
        }
        return new SnapshotReference(run.getApplicationId(), task.getId(), run.getId(),
            snapshot.getBaselineHash(), snapshot.getBaseSourceRevision(),
            snapshot.getCommitHash(), snapshot.getTreeHash());
    }
}
