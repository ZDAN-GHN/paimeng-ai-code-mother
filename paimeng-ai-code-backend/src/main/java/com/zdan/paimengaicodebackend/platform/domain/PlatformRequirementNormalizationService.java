package com.zdan.paimengaicodebackend.platform.domain;

import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.AppMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformNormalizationQueueEventMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformNormalizationQueueMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRequirementMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.mapper.platform.SourceRevisionMapper;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.platform.entity.PlatformNormalizationQueue;
import com.zdan.paimengaicodebackend.platform.entity.PlatformNormalizationQueueEvent;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRequirement;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRun;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import com.zdan.paimengaicodebackend.platform.entity.SourceRevision;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Requirement 归一化编排（Issue #80 / T-08）
 *
 * <p>闭环的第一段：Owner 的自然语言需求在这里变成一个可裁决的 Task 基线，或一个唯一的
 * 决定性业务问题。三条不可协商的边界：
 *
 * <ul>
 *   <li><strong>基线事实来自 Platform，不来自 Agent。</strong>Agent 只产出
 *       {@code requestedOutcome} 与 {@code acceptanceTarget}；{@code baseProfileVersion}
 *       与 {@code baseSourceRevision} 由当前 Application 的稳定事实解析，避免 Agent
 *       声明自己基于哪个版本。</li>
 *   <li><strong>阻断必须恰好一个问题。</strong>D-06 拒绝「多个问题」和「Agent 自行
 *       补全业务规则」，因此只接受单个非空问题，缺失或多个都在这里被拒绝。</li>
 *   <li><strong>阻断期间没有 Run。</strong>{@code created -> blocked} 不创建 Run，
 *       因此 Sandbox 写入权和版本晋升在 Owner 答复前都不存在。</li>
 * </ul>
 */
@Service
public class PlatformRequirementNormalizationService {

    /** 领取到的归一化工作项；attemptId 是回写结果的唯一凭据。 */
    public record Claim(long queueId, long applicationId, long requirementId, long taskId, String attemptId) { }

    /** Owner 答复后的结果：新 Requirement 归属哪个 Task。 */
    public record ClarificationOutcome(long requirementId, long taskId, boolean reopenedSameTask) { }

    private final PlatformTaskMapper taskMapper;
    private final PlatformRunMapper runMapper;
    private final PlatformRequirementMapper requirementMapper;
    private final PlatformNormalizationQueueMapper queueMapper;
    private final PlatformNormalizationQueueEventMapper queueEventMapper;
    private final SourceRevisionMapper sourceRevisionMapper;
    private final AppMapper appMapper;
    private final PlatformLogicalRelationValidator relationValidator;
    private final TaskExecutionBaselineFreezer baselineFreezer;
    private final PlatformTaskLifecycleService lifecycle;
    private final PlatformRunProgressService progress;

    public PlatformRequirementNormalizationService(
        PlatformTaskMapper taskMapper,
        PlatformRunMapper runMapper,
        PlatformRequirementMapper requirementMapper,
        PlatformNormalizationQueueMapper queueMapper,
        PlatformNormalizationQueueEventMapper queueEventMapper,
        SourceRevisionMapper sourceRevisionMapper,
        AppMapper appMapper,
        PlatformLogicalRelationValidator relationValidator,
        TaskExecutionBaselineFreezer baselineFreezer,
        PlatformTaskLifecycleService lifecycle,
        PlatformRunProgressService progress
    ) {
        this.taskMapper = taskMapper;
        this.runMapper = runMapper;
        this.requirementMapper = requirementMapper;
        this.queueMapper = queueMapper;
        this.queueEventMapper = queueEventMapper;
        this.sourceRevisionMapper = sourceRevisionMapper;
        this.appMapper = appMapper;
        this.relationValidator = relationValidator;
        this.baselineFreezer = baselineFreezer;
        this.lifecycle = lifecycle;
        this.progress = progress;
    }

    /**
     * 为一条新 Requirement 建立 Task 并排队归一化。
     *
     * <p>与 Requirement 落库处于同一事务：「已接收但无人负责归一化」不是可接受的状态。
     */
    @Transactional(rollbackFor = Exception.class)
    public PlatformTask openNormalization(long applicationId, PlatformRequirement requirement, String requestId) {
        PlatformTask task = new PlatformTask();
        task.setApplicationId(applicationId);
        task.setRequirementId(requirement.getId());
        task.setState(PlatformTaskState.CREATED.name());
        if (taskMapper.insertSelective(task) != 1) {
            throw new BusinessException(ErrorCode.SYSTEM_ERROR, "Task 写入失败");
        }
        enqueue(applicationId, requirement.getId(), task.getId());
        progress.record(applicationId, task.getId(), null, PlatformProgressStage.NORMALIZING, null);
        return task;
    }

    /**
     * Owner 提交唯一阻断问题的答复。
     *
     * <p>D-06 分两种情形：尚未冻结基线时原 Task 回到 {@code created} 重新归一化；
     * 已有冻结基线时原 Task 保持 {@code blocked}，为重新归一化结果创建新 Task。
     * 两种情形都不修改原基线，也不允许 Agent 直接恢复执行。
     */
    @Transactional(rollbackFor = Exception.class)
    public ClarificationOutcome answerBlockingQuestion(
        long applicationId,
        long taskId,
        String answerText,
        PlatformActor actor,
        String requestId
    ) {
        if (actor != PlatformActor.OWNER && actor != PlatformActor.SYSTEM_ADMINISTRATOR) {
            throw new BusinessException(ErrorCode.NO_AUTH_ERROR, "只有 Owner 或 System Administrator 可以答复阻断问题");
        }
        if (answerText == null || answerText.isBlank()) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "答复内容不能为空");
        }
        relationValidator.requireActiveApplication(applicationId);
        relationValidator.requireTaskBelongsToApplication(applicationId, taskId);
        PlatformTask task = taskMapper.selectOneById(taskId);
        if (task == null || !PlatformTaskState.BLOCKED.name().equals(task.getState())) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Task 当前不处于可答复的阻断状态");
        }
        if (task.getBlockedQuestion() == null || task.getBlockedQuestion().isBlank()) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Task 没有待答复的阻断问题");
        }

        PlatformRequirement answer = new PlatformRequirement();
        answer.setApplicationId(applicationId);
        answer.setKind("CLARIFICATION_ANSWER");
        answer.setParentRequirementId(task.getRequirementId());
        answer.setOriginalText(answerText.trim());
        if (requirementMapper.insertSelective(answer) != 1) {
            throw new BusinessException(ErrorCode.SYSTEM_ERROR, "答复写入失败");
        }

        boolean baselineFrozen = task.getBaselineJson() != null;
        long targetTaskId;
        if (baselineFrozen) {
            targetTaskId = createSuccessorTask(applicationId, task.getId(), answer.getId());
        } else {
            lifecycle.reopenForReNormalization(taskId, "OWNER_CLARIFICATION_ANSWERED", requestId + "-reopen");
            taskMapper.clearBlockingQuestion(taskId);
            targetTaskId = taskId;
        }
        enqueue(applicationId, answer.getId(), targetTaskId);
        progress.record(applicationId, targetTaskId, null, PlatformProgressStage.NORMALIZING, null);
        return new ClarificationOutcome(answer.getId(), targetTaskId, !baselineFrozen);
    }

    /** 领取一条待归一化的 Requirement。空队列返回 {@link Optional#empty()}，不是错误。 */
    @Transactional(rollbackFor = Exception.class)
    public Optional<Claim> claimNext() {
        PlatformNormalizationQueue candidate = queueMapper.selectClaimable();
        if (candidate == null) {
            return Optional.empty();
        }
        int previousAttempt = candidate.getAttemptNumber() == null ? 0 : candidate.getAttemptNumber();
        if (previousAttempt == Integer.MAX_VALUE) {
            throw denied("归一化尝试次数已达上限");
        }
        String attempt = UUID.randomUUID().toString();
        if (queueMapper.claim(candidate.getId(), attempt, previousAttempt + 1) != 1) {
            throw denied("归一化队列领取冲突");
        }
        appendEvent(candidate.getId(), candidate.getTaskId(), attempt, "RUNNING", null);
        return Optional.of(new Claim(candidate.getId(), candidate.getAppId(), candidate.getRequirementId(),
            candidate.getTaskId(), attempt));
    }

    /**
     * 归一化结果为「需求明确」：冻结基线、进入 {@code ready} 并创建受控 Run。
     *
     * <p>Run 由 Platform 在这里创建（D-06：{@code ready -> executing} 的前置是 Platform
     * 创建 Run），Runtime 之后只能通过领取工作项拿到它。
     */
    @Transactional(rollbackFor = Exception.class)
    public PlatformRun acceptReadyOutcome(
        Claim claim,
        String requestedOutcome,
        String acceptanceTarget,
        String requestId
    ) {
        requireRunningClaim(claim);
        requireText(requestedOutcome, "归一化结果缺少 requestedOutcome");
        requireText(acceptanceTarget, "归一化结果缺少 acceptanceTarget");
        PlatformTask task = requireCreatedTask(claim);

        App application = appMapper.selectOneById(claim.applicationId());
        if (application == null) {
            throw denied("归一化目标 Application 不存在");
        }
        SourceRevision base = application.getStableSourceRevision() == null
            ? null
            : sourceRevisionMapper.selectOneById(application.getStableSourceRevision());
        if (base != null && !base.getApplicationId().equals(claim.applicationId())) {
            throw denied("Application 稳定版本归属不一致");
        }
        TaskExecutionBaseline baseline = new TaskExecutionBaseline(
            TaskExecutionBaseline.CURRENT_SCHEMA_VERSION,
            base == null ? null : base.getProfileVersionId(),
            application.getStableSourceRevision(),
            requestedOutcome.trim(),
            acceptanceTarget.trim()
        );
        baselineFreezer.freeze(task, baseline);
        settleQueue(claim, "READY", "NORMALIZED");
        lifecycle.markReady(task.getId(), "BASELINE_FROZEN", requestId + "-ready");
        PlatformRun run = createRun(claim.applicationId(), task.getId());
        return run;
    }

    /**
     * 归一化结果为「存在决定性业务歧义」：Task 进入 {@code blocked} 并记录唯一问题。
     *
     * <p>这里不创建 Run、不启动 Sandbox、不晋升任何版本；Owner 答复后由
     * {@link #answerBlockingQuestion} 沿 D-06 允许的边重新归一化。
     */
    @Transactional(rollbackFor = Exception.class)
    public void acceptBlockedOutcome(Claim claim, String blockingQuestion, String requestId) {
        requireRunningClaim(claim);
        requireText(blockingQuestion, "归一化结果必须给出唯一的决定性业务问题");
        PlatformTask task = requireCreatedTask(claim);
        settleQueue(claim, "BLOCKED", "DECISIVE_AMBIGUITY");
        lifecycle.markBlockedForClarification(task.getId(), blockingQuestion, "DECISIVE_AMBIGUITY", requestId + "-blocked");
        progress.record(claim.applicationId(), task.getId(), null,
            PlatformProgressStage.NORMALIZATION_BLOCKED, null);
    }

    /**
     * 归一化本身失败（例如模型不可用、输出无法解析）。
     *
     * <p>Task 保持 {@code created}，队列行进入终态 {@code FAILED} 留证，等待 Owner 提交
     * 新 Requirement。不会伪造阻断问题：那会把基础设施失败说成业务歧义。
     */
    @Transactional(rollbackFor = Exception.class)
    public void acceptFailedOutcome(Claim claim, String reasonCode, String requestId) {
        requireRunningClaim(claim);
        requireReasonCode(reasonCode);
        requireCreatedTask(claim);
        settleQueue(claim, "FAILED", reasonCode);
    }

    /** 领取一个 {@code ready} Task 的待启动 Run。空队列返回 {@link Optional#empty()}。 */
    @Transactional(rollbackFor = Exception.class)
    public Optional<PlatformRun> claimStartableRun() {
        return Optional.ofNullable(runMapper.selectStartableRun());
    }

    /**
     * 按 {@code attemptId} 反查真实队列凭据。
     *
     * <p>回写不能由调用方构造 Claim：queueId 与 requirementId 必须来自 Platform 自己的
     * 队列行，否则一次合法领取可以被伪造的 Requirement 顶替，状态机也就失去意义。
     */
    @Transactional(readOnly = true)
    public Claim requireRunningClaim(long applicationId, long taskId, String attemptId) {
        if (attemptId == null || attemptId.isBlank()) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "归一化凭据不完整");
        }
        PlatformNormalizationQueue queue = latestQueueForTask(taskId);
        if (queue == null
            || queue.getAttemptId() == null
            || !queue.getAttemptId().equals(attemptId)
            || !queue.getAppId().equals(applicationId)
            || !"RUNNING".equals(queue.getState())) {
            throw denied("归一化凭据已失效或不属于该 Task");
        }
        return new Claim(queue.getId(), queue.getAppId(), queue.getRequirementId(), queue.getTaskId(), attemptId);
    }

    /** 该 Application 最近一次归一化工作项的 Task；没有工作项时返回 0。 */
    @Transactional(readOnly = true)
    public long latestTaskIdForApplication(long applicationId) {
        List<PlatformNormalizationQueue> rows = queueMapper.selectListByQuery(
            QueryWrapper.create().eq("appId", applicationId).orderBy("id", false).limit(1));
        if (rows.isEmpty()) {
            throw new BusinessException(ErrorCode.NOT_FOUND_ERROR, "该 Application 没有待推进的执行事实");
        }
        return rows.getFirst().getTaskId();
    }

    /** Requirement 的归一化状态投影，供 Requirement 列表与详情复用。 */
    @Transactional(readOnly = true)
    public String normalizationStatus(Long applicationId, Long requirementId) {
        if (applicationId == null || requirementId == null) {
            return "PENDING_NORMALIZATION";
        }
        PlatformNormalizationQueue queue = queueMapper.selectOneByQuery(
            QueryWrapper.create().eq("requirementId", requirementId));
        if (queue == null) {
            return "PENDING_NORMALIZATION";
        }
        return switch (queue.getState()) {
            case "PENDING" -> "PENDING_NORMALIZATION";
            case "RUNNING" -> "NORMALIZING";
            default -> queue.getState();
        };
    }

    /** 最近一个归一化队列行，用于状态投影判断 Task 是否仍在等待归一化。 */
    @Transactional(readOnly = true)
    public PlatformNormalizationQueue latestQueueForTask(long taskId) {
        List<PlatformNormalizationQueue> rows = queueMapper.selectListByQuery(
            QueryWrapper.create().eq("taskId", taskId).orderBy("id", false));
        return rows.isEmpty() ? null : rows.getFirst();
    }

    private long createSuccessorTask(long applicationId, Long parentTaskId, long requirementId) {
        PlatformTask successor = new PlatformTask();
        successor.setApplicationId(applicationId);
        successor.setRequirementId(requirementId);
        successor.setParentTaskId(parentTaskId);
        successor.setState(PlatformTaskState.CREATED.name());
        if (taskMapper.insertSelective(successor) != 1) {
            throw new BusinessException(ErrorCode.SYSTEM_ERROR, "Task 写入失败");
        }
        return successor.getId();
    }

    private void enqueue(long applicationId, long requirementId, long taskId) {
        PlatformNormalizationQueue queue = new PlatformNormalizationQueue();
        queue.setAppId(applicationId);
        queue.setRequirementId(requirementId);
        queue.setTaskId(taskId);
        queue.setState("PENDING");
        queue.setAttemptNumber(0);
        if (queueMapper.insertSelective(queue) != 1) {
            throw new BusinessException(ErrorCode.SYSTEM_ERROR, "归一化队列写入失败");
        }
        appendEvent(queue.getId(), taskId, null, "PENDING", null);
    }

    private PlatformRun createRun(long applicationId, long taskId) {
        PlatformRun run = new PlatformRun();
        run.setId("run-" + UUID.randomUUID());
        run.setApplicationId(applicationId);
        run.setTaskId(taskId);
        run.setState(PlatformRunState.CREATED.name());
        run.setAttemptNumber(1);
        if (runMapper.insertSelective(run) != 1) {
            throw new BusinessException(ErrorCode.SYSTEM_ERROR, "Run 写入失败");
        }
        return run;
    }

    private void requireRunningClaim(Claim claim) {
        if (claim == null || claim.queueId() <= 0 || claim.attemptId() == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "归一化凭据不完整");
        }
    }

    private PlatformTask requireCreatedTask(Claim claim) {
        relationValidator.requireTaskBelongsToApplication(claim.applicationId(), claim.taskId());
        PlatformTask task = taskMapper.selectOneById(claim.taskId());
        if (task == null || !PlatformTaskState.CREATED.name().equals(task.getState())) {
            throw denied("Task 当前状态不接受归一化结果");
        }
        if (!normalizesThisTask(claim, task)) {
            throw denied("归一化结果与 Task 的 Requirement 不一致");
        }
        return task;
    }

    /**
     * 归一化必须归属该 Task。
     *
     * <p>两种合法归属：Requirement 就是 Task 自己的原始需求；或者它是针对同一 Task 的阻断
     * 答复（{@code blocked -> created} 重开时 Task 的 {@code requirementId} 仍指向原始需求，
     * 答复是新的一行并通过 {@code parentRequirementId} 指回它）。其余情况一律拒绝，
     * 否则 Agent 可以用别的 Requirement 顶替自己的结果。
     */
    private boolean normalizesThisTask(Claim claim, PlatformTask task) {
        if (task.getRequirementId() != null && task.getRequirementId() == claim.requirementId()) {
            return true;
        }
        PlatformRequirement requirement = requirementMapper.selectOneById(claim.requirementId());
        return requirement != null
            && requirement.getApplicationId().equals(claim.applicationId())
            && "CLARIFICATION_ANSWER".equals(requirement.getKind())
            && requirement.getParentRequirementId() != null
            && requirement.getParentRequirementId().equals(task.getRequirementId());
    }

    private void settleQueue(Claim claim, String state, String reasonCode) {
        if (queueMapper.settle(claim.queueId(), claim.taskId(), claim.attemptId(), state, reasonCode) != 1) {
            throw denied("归一化租约已失效或结果重复提交");
        }
        appendEvent(claim.queueId(), claim.taskId(), claim.attemptId(), state, reasonCode);
    }

    private void appendEvent(long queueId, long taskId, String attemptId, String state, String reasonCode) {
        PlatformNormalizationQueueEvent event = new PlatformNormalizationQueueEvent();
        event.setQueueId(queueId);
        event.setTaskId(taskId);
        event.setAttemptId(attemptId);
        event.setToState(state);
        event.setReasonCode(reasonCode);
        if (queueEventMapper.insertSelective(event) != 1) {
            throw denied("归一化队列审计写入失败");
        }
    }

    private void requireText(String value, String message) {
        if (value == null || value.isBlank()) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, message);
        }
    }

    private void requireReasonCode(String reasonCode) {
        if (reasonCode == null || !reasonCode.matches("[A-Z][A-Z0-9_]{0,63}")) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "归一化失败原因码不合法");
        }
    }

    private BusinessException denied(String message) {
        return new BusinessException(ErrorCode.FORBIDDEN_ERROR, message);
    }
}
