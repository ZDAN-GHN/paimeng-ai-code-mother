package com.zdan.paimengaicodebackend.platform.service;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRequirementMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.platform.domain.PlatformProgressStage;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRequirementNormalizationService;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunProgressService;
import com.zdan.paimengaicodebackend.platform.dto.PlatformNormalizationResultRequest;
import com.zdan.paimengaicodebackend.platform.dto.PlatformRunProgressRequest;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRequirement;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRun;
import com.zdan.paimengaicodebackend.platform.vo.PlatformNormalizationWorkItemVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformRunWorkItemVO;
import java.util.Optional;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Agent 工作项的领取与回写（Issue #80 / T-08）
 *
 * <p>Agent 是拉取方而不是被调用方：Platform 只暴露「现在该做什么」，不假设 Agent 存在、
 * 在线或已部署。这样 Runtime 崩溃、模型不可用时闭环停在 {@code created}，而不是留下
 * 半截状态或一段无人负责的等待。
 *
 * <p>三条约束：
 * <ul>
 *   <li>actor 一律由 Platform 记为 {@code RUNTIME} 或 {@code PLATFORM}，Agent 不能自报身份；</li>
 *   <li>所有回写都必须携带 Platform 发出的凭据（归一化 attemptId、执行 fence token），
 *       过期或错配的凭据一律拒绝；</li>
 *   <li>归一化结果不能直接写 Task 状态：它只被翻译成 D-06 允许的转换。</li>
 * </ul>
 */
@Service
public class PlatformAgentWorkService {

    private final PlatformRequirementNormalizationService normalizationService;
    private final PlatformRequirementMapper requirementMapper;
    private final PlatformRunMapper runMapper;
    private final PlatformRunProgressService progressService;

    public PlatformAgentWorkService(
        PlatformRequirementNormalizationService normalizationService,
        PlatformRequirementMapper requirementMapper,
        PlatformRunMapper runMapper,
        PlatformRunProgressService progressService
    ) {
        this.normalizationService = normalizationService;
        this.requirementMapper = requirementMapper;
        this.runMapper = runMapper;
        this.progressService = progressService;
    }

    /**
     * 领取一条待归一化的 Requirement。队列为空返回 {@link Optional#empty()}，不是错误。
     *
     * <p>刻意不是只读事务：领取要写 attemptId 并对队列行加 {@code FOR UPDATE SKIP LOCKED}，
     * 挂在只读事务上会让「领取」退化成不受保护的读。
     */
    @Transactional(rollbackFor = Exception.class)
    public Optional<PlatformNormalizationWorkItemVO> claimNormalization() {
        return normalizationService.claimNext().map(claim -> {
            PlatformRequirement requirement = requirementMapper.selectOneById(claim.requirementId());
            if (requirement == null
                || !requirement.getApplicationId().equals(claim.applicationId())
                || !requirement.getId().equals(claim.requirementId())) {
                throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "归一化工作项的 Requirement 归属不一致");
            }
            PlatformRequirement parent = requirement.getParentRequirementId() == null
                ? null
                : requirementMapper.selectOneById(requirement.getParentRequirementId());
            if (parent != null && !parent.getApplicationId().equals(claim.applicationId())) {
                throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "答复与原 Requirement 归属不一致");
            }
            PlatformNormalizationWorkItemVO item = new PlatformNormalizationWorkItemVO();
            item.setApplicationId(String.valueOf(claim.applicationId()));
            item.setRequirementId(String.valueOf(claim.requirementId()));
            item.setTaskId(String.valueOf(claim.taskId()));
            item.setAttemptId(claim.attemptId());
            item.setRequirementText(requirement.getOriginalText());
            item.setRequirementKind(requirement.getKind());
            item.setParentRequirementId(
                requirement.getParentRequirementId() == null
                    ? null
                    : String.valueOf(requirement.getParentRequirementId()));
            item.setParentRequirementText(parent == null ? null : parent.getOriginalText());
            return item;
        });
    }

    /**
     * 回写归一化结果。
     *
     * <p>三种结论在这里被强制成互斥的必填组合：无法同时给出可执行基线和阻断问题，
     * 也无法只提交一个空问题。凭据按 {@code attemptId + taskId} 反查真实队列行，
     * 因此 Agent 无法用别人的 Requirement 顶替自己的结果。
     */
    @Transactional(rollbackFor = Exception.class)
    public void reportNormalization(PlatformNormalizationResultRequest request) {
        if (request == null || request.getOutcome() == null || request.getAttemptId() == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "归一化结果参数不完整");
        }
        long applicationId = parseIdentifier(request.getApplicationId(), "Application ID 无效");
        long taskId = parseIdentifier(request.getTaskId(), "Task ID 无效");
        String requestId = requireRequestId(request.getRequestId());
        var claim = normalizationService.requireRunningClaim(applicationId, taskId, request.getAttemptId());

        switch (request.getOutcome()) {
            case PlatformNormalizationResultRequest.OUTCOME_READY -> {
                rejectIfPresent(request.getBlockingQuestion(), "READY 结果不能同时携带阻断问题");
                normalizationService.acceptReadyOutcome(
                    claim, request.getRequestedOutcome(), request.getAcceptanceTarget(), requestId);
                progressService.record(applicationId, taskId, null, PlatformProgressStage.EXECUTING, null);
            }
            case PlatformNormalizationResultRequest.OUTCOME_BLOCKED -> {
                rejectIfPresent(request.getRequestedOutcome(), "BLOCKED 结果不能同时携带可执行基线");
                rejectIfPresent(request.getAcceptanceTarget(), "BLOCKED 结果不能同时携带可执行基线");
                normalizationService.acceptBlockedOutcome(claim, request.getBlockingQuestion(), requestId);
            }
            case PlatformNormalizationResultRequest.OUTCOME_FAILED -> normalizationService
                .acceptFailedOutcome(claim, request.getReasonCode(), requestId);
            default -> throw new BusinessException(ErrorCode.PARAMS_ERROR, "归一化结论不在契约内");
        }
    }

    /** 领取一个 {@code ready} Task 的待启动 Run。队列为空返回 {@link Optional#empty()}。 */
    @Transactional(rollbackFor = Exception.class)
    public Optional<PlatformRunWorkItemVO> claimRun() {
        return normalizationService.claimStartableRun().map(this::toWorkItem);
    }

    /**
     * Runtime 上报粗粒度阶段。
     *
     * <p>Task 归属由 Platform 解析而不是由调用方声明：给了 runId 就从 Run 查，
     * 没给就取该 Application 最近的归一化工作项（归一化阶段尚不存在 Run）。
     */
    @Transactional(rollbackFor = Exception.class)
    public void reportProgress(PlatformRunProgressRequest request) {
        if (request == null || request.getStage() == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "进度上报参数不完整");
        }
        long applicationId = parseIdentifier(request.getApplicationId(), "Application ID 无效");
        PlatformProgressStage stage;
        try {
            stage = PlatformProgressStage.valueOf(request.getStage());
        } catch (IllegalArgumentException unknownStage) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "执行阶段不在契约内");
        }
        requireRequestId(request.getRequestId());
        long taskId = resolveTaskId(applicationId, request.getRunId());
        progressService.record(applicationId, taskId, request.getRunId(), stage, request.getNote());
    }

    private PlatformRunWorkItemVO toWorkItem(PlatformRun run) {
        PlatformRunWorkItemVO item = new PlatformRunWorkItemVO();
        item.setApplicationId(String.valueOf(run.getApplicationId()));
        item.setTaskId(String.valueOf(run.getTaskId()));
        item.setRunId(run.getId());
        item.setAttemptNumber(run.getAttemptNumber());
        return item;
    }

    private long resolveTaskId(long applicationId, String runId) {
        if (runId != null && !runId.isBlank()) {
            PlatformRun run = runMapper.selectOneById(runId);
            if (run == null || !run.getApplicationId().equals(applicationId)) {
                throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Run 不存在或不属于该 Application");
            }
            return run.getTaskId();
        }
        return normalizationService.latestTaskIdForApplication(applicationId);
    }

    private void rejectIfPresent(String value, String message) {
        if (value != null && !value.isBlank()) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, message);
        }
    }

    private String requireRequestId(String requestId) {
        if (requestId == null || requestId.isBlank() || requestId.length() > 64) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "请求幂等键不合法");
        }
        return requestId;
    }

    private long parseIdentifier(String text, String message) {
        if (text == null || !text.matches("[1-9]\\d{0,18}")) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, message);
        }
        try {
            return Long.parseLong(text);
        } catch (NumberFormatException notANumber) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, message);
        }
    }
}
