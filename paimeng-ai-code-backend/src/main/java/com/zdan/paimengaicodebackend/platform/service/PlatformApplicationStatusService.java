package com.zdan.paimengaicodebackend.platform.service;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformDeploymentMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.model.entity.User;
import com.zdan.paimengaicodebackend.platform.deployment.PlatformDeploymentReasonCode;
import com.zdan.paimengaicodebackend.platform.deployment.PlatformDeploymentStage;
import com.zdan.paimengaicodebackend.platform.deployment.PublicApplicationRouteResolver;
import com.zdan.paimengaicodebackend.platform.domain.PlatformApplicationAccessGuard;
import com.zdan.paimengaicodebackend.platform.domain.PlatformOwnerVisibleStatus;
import com.zdan.paimengaicodebackend.platform.domain.PlatformProgressStage;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRequirementNormalizationService;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunProgressService;
import com.zdan.paimengaicodebackend.platform.domain.PlatformStatusChangeNotifier;
import com.zdan.paimengaicodebackend.platform.domain.PlatformTaskRetryService;
import com.zdan.paimengaicodebackend.platform.domain.PlatformTaskState;
import com.zdan.paimengaicodebackend.platform.entity.PlatformNormalizationQueue;
import com.zdan.paimengaicodebackend.platform.entity.PlatformDeployment;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRun;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRunProgressEvent;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import com.zdan.paimengaicodebackend.platform.vo.PlatformApplicationStatusVO;
import com.zdan.paimengaicodebackend.platform.dto.PlatformTaskRetryRequest;
import com.zdan.paimengaicodebackend.platform.vo.PlatformClarificationAnswerVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformTaskRetryVO;
import java.time.LocalDateTime;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Owner 可见的执行状态投影（Issue #80 / T-08）
 *
 * <p>投影只回答两个问题：现在到哪一步、下一步该做什么。它读 Platform 的权威事实
 * （Task/Run 状态、归一化队列、进度阶段），因此不可能出现与状态机不一致的展示；
 * 同时它刻意不把 Pi Session、工具细节、Sandbox 标识、Snapshot 哈希或 Validation
 * Evidence 引用投影出去——那些是内部证据链，不是 Product Layer 语言。
 */
@Service
public class PlatformApplicationStatusService {

    /** 平台内部失败原因码到 Owner 语言的固定映射。未登记的原因码一律不展示。 */
    private static final Map<String, String> FAILURE_REASONS = Map.of(
        "VALIDATION_FAILED", "验证没有通过，可以查看要求后重新提交需求。",
        "VALIDATION_INCONCLUSIVE", "验证环境没能给出确定结论，本次构建未通过验证。",
        "NORMALIZATION_FAILED", "整理需求时出现异常，请重新提交一次需求。"
    );

    private final PlatformApplicationAccessGuard accessGuard;
    private final PlatformTaskMapper taskMapper;
    private final PlatformRunMapper runMapper;
    private final PlatformRequirementNormalizationService normalizationService;
    private final PlatformRunProgressService progressService;
    private final PlatformTaskRetryService retryService;
    private final PlatformStatusChangeNotifier notifier;
    private final PlatformDeploymentMapper deploymentMapper;
    private final PublicApplicationRouteResolver routeResolver;

    public PlatformApplicationStatusService(
        PlatformApplicationAccessGuard accessGuard,
        PlatformTaskMapper taskMapper,
        PlatformRunMapper runMapper,
        PlatformRequirementNormalizationService normalizationService,
        PlatformRunProgressService progressService,
        PlatformTaskRetryService retryService,
        PlatformStatusChangeNotifier notifier,
        PlatformDeploymentMapper deploymentMapper,
        PublicApplicationRouteResolver routeResolver
    ) {
        this.accessGuard = accessGuard;
        this.taskMapper = taskMapper;
        this.runMapper = runMapper;
        this.normalizationService = normalizationService;
        this.progressService = progressService;
        this.retryService = retryService;
        this.notifier = notifier;
        this.deploymentMapper = deploymentMapper;
        this.routeResolver = routeResolver;
    }

    /**
     * 读取 Owner 状态投影。
     *
     * <p>归档后的 Application 仍可读取：AD-015 要求归档保留全部关联事实，停止的是
     * 接受新需求与执行，不是抹掉历史。
     */
    @Transactional(readOnly = true)
    public PlatformApplicationStatusVO getStatus(Long applicationId, User actor) {
        App application = accessGuard.requireReadable(applicationId, actor);
        PlatformApplicationStatusVO status = new PlatformApplicationStatusVO();
        status.setApplicationId(String.valueOf(application.getId()));
        status.setArchived("ARCHIVED".equals(application.getLifecycleStatus()));

        PlatformTask task = taskMapper.selectLatestForApplication(applicationId);
        if (task == null) {
            status.setStatus(PlatformOwnerVisibleStatus.AWAITING_NORMALIZATION);
            status.setHeadline(PlatformOwnerVisibleStatus.AWAITING_NORMALIZATION.headline());
            status.setDetail("先描述你希望这个 Application 帮你完成什么，我们再一起把需求确认清楚。");
            status.setUpdatedAt(application.getUpdateTime() == null ? application.getCreateTime() : application.getUpdateTime());
            return status;
        }

        PlatformNormalizationQueue queue = normalizationService.latestQueueForTask(task.getId());
        PlatformRun run = runMapper.selectLatestForTask(task.getId());
        PlatformRunProgressEvent progress = progressService.latest(applicationId, task.getId());

        status.setRequirementId(identifier(task.getRequirementId()));
        status.setTaskId(identifier(task.getId()));
        status.setRunId(run == null ? null : run.getId());
        status.setUpdatedAt(latestOf(task.getUpdatedAt(), run, progress));

        PlatformOwnerVisibleStatus visible = visibleStatus(task, queue);
        status.setStatus(visible);
        status.setHeadline(visible.headline());
        status.setDetail(detailFor(visible));
        if (visible == PlatformOwnerVisibleStatus.BLOCKED && task.getBlockedQuestion() != null
            && !task.getBlockedQuestion().isBlank()) {
            status.setAnswerRequired(true);
            status.setBlockingQuestion(task.getBlockedQuestion().trim());
            status.setDetail("我们只需要确认一件事，确认后就会继续构建。");
        }
        if (visible == PlatformOwnerVisibleStatus.FAILED) {
            status.setFailureReason(failureReason(task, queue));
        }
        if (progress != null && progress.getStage() != null) {
            try {
                status.setProgressStage(PlatformProgressStage.valueOf(progress.getStage()));
            } catch (IllegalArgumentException unknownStage) {
                // 未知阶段不外泄：投影退回到只有 Task 状态。
                status.setProgressStage(null);
            }
        }
        applyDeploymentProjection(status, applicationId, visible);
        return status;
    }

    /**
     * 叠加「是否已上线」与受控诊断（Issue #81 / T-09）。
     *
     * <p>AD-010：Task {@code released} 只表示固定 Release 已创建，不代表线上有东西在跑。
     * 因此这一段既是「已上线」的唯一定义处，也是唯一会把 {@code RELEASED} 的标题改写成
     * 「未上线」的地方——两处若分开写，迟早会有一处漏掉，Owner 就会看到「已发布固定版本」
     * 却打不开公开地址。
     */
    private void applyDeploymentProjection(
        PlatformApplicationStatusVO status,
        Long applicationId,
        PlatformOwnerVisibleStatus visible
    ) {
        PlatformDeployment healthy = deploymentMapper.selectHealthyForApplication(applicationId);
        if (healthy != null) {
            status.setLive(true);
            status.setPublicUrl(routeResolver.publicBasePath() + "/" + applicationId + "/");
            status.setDeployStage(publishableStage(healthy.getStage()));
            return;
        }
        status.setLive(false);
        status.setPublicUrl(null);
        PlatformDeployment latest = deploymentMapper.selectLatestForApplication(applicationId);
        if (latest == null) {
            return;
        }
        String stage = publishableStage(latest.getStage());
        status.setDeployStage(stage);
        PlatformDeploymentReasonCode reason = PlatformDeploymentReasonCode.of(latest.getReasonCode());
        if (reason != null) {
            status.setDeployReason(reason.name());
        }
        if (visible != PlatformOwnerVisibleStatus.RELEASED) {
            return;
        }
        if (PlatformDeploymentStage.UNHEALTHY.name().equals(stage)) {
            status.setHeadline(PlatformDeploymentStage.UNHEALTHY.ownerText());
            status.setDetail(reason == null
                ? "这个版本没有通过上线前检查，应用暂未对外开放；你的需求和已确认的目标都保留着。"
                : reason.ownerText() + "，应用暂未对外开放；你的需求和已确认的目标都保留着。");
        } else {
            status.setHeadline("已创建固定版本，正在准备上线");
            status.setDetail("上线前检查通过后，这个版本就会通过公开地址对外提供服务。");
        }
    }

    /** 白名单过滤：未登记的阶段码不外发，宁可缺字段也不透传数据库里的任意值。 */
    private String publishableStage(String raw) {
        try {
            return raw == null ? null : PlatformDeploymentStage.valueOf(raw).name();
        } catch (IllegalArgumentException unregistered) {
            return null;
        }
    }

    /**
     * Owner 提交唯一阻断问题的答复。
     *
     * <p>鉴权与「答复前不得启动 Sandbox 写入」由
     * {@link PlatformRequirementNormalizationService} 再次确认：这里只负责主体校验
     * 和把答复落成不可变 Requirement 的入口。
     */
    @Transactional(rollbackFor = Exception.class)
    public PlatformClarificationAnswerVO answerBlockingQuestion(
        Long applicationId,
        String taskIdText,
        String answerText,
        User actor
    ) {
        accessGuard.requireManaged(applicationId, actor);
        long taskId = parseIdentifier(taskIdText, "Task ID 无效");
        if (answerText == null || answerText.isBlank()) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "答复内容不能为空");
        }
        if (answerText.length() > 4000) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "答复内容过长");
        }
        var outcome = normalizationService.answerBlockingQuestion(
            applicationId, taskId, answerText, accessGuard.actorFor(actor), UUID.randomUUID().toString());

        PlatformClarificationAnswerVO response = new PlatformClarificationAnswerVO();
        response.setAnswerRequirementId(String.valueOf(outcome.requirementId()));
        response.setTaskId(String.valueOf(outcome.taskId()));
        response.setReopenedSameTask(outcome.reopenedSameTask());
        response.setAcceptedAt(LocalDateTime.now());
        return response;
    }

    /**
     * Owner 对失败 Task 请求重试。
     *
     * <p>与阻断答复同一条边界：先校验主体与 Task 归属，再由 Platform 受理重试事实并裁决状态。
     * 重试不会改写 Requirement 或冻结基线，因此不需要（也不允许）携带目标类参数。
     */
    @Transactional(rollbackFor = Exception.class)
    public PlatformTaskRetryVO requestRetry(
        Long applicationId,
        String taskIdText,
        PlatformTaskRetryRequest request,
        User actor
    ) {
        accessGuard.requireManaged(applicationId, actor);
        long taskId = parseIdentifier(taskIdText, "Task ID 无效");
        var outcome = retryService.requestRetry(
            applicationId,
            taskId,
            accessGuard.actorFor(actor),
            request == null ? null : request.getReason(),
            request == null ? null : request.getRequestId()
        );
        notifier.notifyAfterCommit(applicationId);

        PlatformTaskRetryVO response = new PlatformTaskRetryVO();
        response.setTaskId(String.valueOf(outcome.taskId()));
        response.setRunId(outcome.runId());
        response.setAttemptNumber(outcome.attemptNumber());
        response.setAcceptedAt(LocalDateTime.now());
        return response;
    }

    private PlatformOwnerVisibleStatus visibleStatus(PlatformTask task, PlatformNormalizationQueue queue) {
        if (PlatformTaskState.CREATED.name().equals(task.getState())) {
            // Task 还在 created：要么在等归一化，要么归一化自身失败。两者对 Owner 的
            // 下一步完全不同，因此必须读队列事实而不是猜。
            return queue != null && "FAILED".equals(queue.getState())
                ? PlatformOwnerVisibleStatus.FAILED
                : PlatformOwnerVisibleStatus.AWAITING_NORMALIZATION;
        }
        try {
            return switch (PlatformTaskState.valueOf(task.getState())) {
                case READY -> PlatformOwnerVisibleStatus.READY;
                case EXECUTING -> PlatformOwnerVisibleStatus.EXECUTING;
                case BLOCKED -> PlatformOwnerVisibleStatus.BLOCKED;
                case FAILED -> PlatformOwnerVisibleStatus.FAILED;
                case VALIDATED -> PlatformOwnerVisibleStatus.VALIDATED;
                case RELEASED -> PlatformOwnerVisibleStatus.RELEASED;
                case CANCELLED -> PlatformOwnerVisibleStatus.CANCELLED;
                case CREATED -> PlatformOwnerVisibleStatus.AWAITING_NORMALIZATION;
            };
        } catch (IllegalArgumentException unknownState) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Task 状态不在平台契约内");
        }
    }

    private String detailFor(PlatformOwnerVisibleStatus status) {
        return switch (status) {
            case AWAITING_NORMALIZATION -> "我们正在把你的描述整理成可执行的开发目标，稍后会自动继续。";
            case READY -> "开发目标已确认，正在为你安排构建。";
            case EXECUTING -> "正在构建你的 Application，完成后会先验证再交给你。";
            case BLOCKED -> "我们只需要确认一件事，确认后就会继续构建。";
            case FAILED -> "本次构建没有通过验证，你的需求和已确认的目标都保留着。";
            case VALIDATED -> "验证已通过，这个版本已经是可用的稳定基线。";
            case RELEASED -> "已创建固定版本，是否已上线由部署健康状态单独判定。";
            case CANCELLED -> "这次构建已取消，需求和已确认的目标仍然保留。";
        };
    }

    private String failureReason(PlatformTask task, PlatformNormalizationQueue queue) {
        if (PlatformTaskState.CREATED.name().equals(task.getState()) && queue != null) {
            return FAILURE_REASONS.get("NORMALIZATION_FAILED");
        }
        return task.getFailureCode() == null ? null : FAILURE_REASONS.get(task.getFailureCode());
    }

    private LocalDateTime latestOf(LocalDateTime taskUpdatedAt, PlatformRun run, PlatformRunProgressEvent progress) {
        LocalDateTime latest = taskUpdatedAt;
        if (run != null && run.getUpdatedAt() != null && (latest == null || run.getUpdatedAt().isAfter(latest))) {
            latest = run.getUpdatedAt();
        }
        if (progress != null && progress.getOccurredTime() != null
            && (latest == null || progress.getOccurredTime().isAfter(latest))) {
            latest = progress.getOccurredTime();
        }
        return latest;
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

    private String identifier(Long value) {
        return value == null ? null : String.valueOf(value);
    }
}
