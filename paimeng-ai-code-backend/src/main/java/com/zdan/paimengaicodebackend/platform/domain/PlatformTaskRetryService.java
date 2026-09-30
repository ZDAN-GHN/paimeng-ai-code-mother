package com.zdan.paimengaicodebackend.platform.domain;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskRetryRequestMapper;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRun;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTaskRetryRequest;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Owner 显式重试（Issue #80 / Slice 2）
 *
 * <p>D-06：{@code failed -> ready} 的触发是「Owner 显式请求重试；Platform 创建新 Run，
 * Requirement 与冻结基线不变」。拒绝条件是「改变业务目标、基线或验收目标时必须创建新
 * Requirement/Task」。
 *
 * <p>最后一条是结构性保证，不是运行时检查：{@link PlatformTaskRetryRequest} 只记录
 * 「重试」这一个动作，没有任何字段能承载新的基线或验收目标。也就是说，即使将来有人想
 * 「顺便改一下验收目标」，契约里也没有位置可填，必须另建 Requirement——这正是 D-06 想要的。
 *
 * <p>受理顺序不可交换：先把重试请求作为事实落库，再让状态机转换。
 * {@link PlatformTaskTransitionService} 会自己实查这张表来决定
 * {@code retryRequestedByOwner} 是否成立，因此事实必须先于转换存在。
 */
@Service
public class PlatformTaskRetryService {

    /** 重试结果：Owner 看到的回执。 */
    public record RetryOutcome(long taskId, String runId, int attemptNumber) { }

    private static final int MAX_REASON_LENGTH = 500;

    private final PlatformTaskMapper taskMapper;
    private final PlatformRunMapper runMapper;
    private final PlatformTaskRetryRequestMapper retryMapper;
    private final PlatformLogicalRelationValidator relationValidator;
    private final PlatformTaskTransitionService transitions;

    public PlatformTaskRetryService(
        PlatformTaskMapper taskMapper,
        PlatformRunMapper runMapper,
        PlatformTaskRetryRequestMapper retryMapper,
        PlatformLogicalRelationValidator relationValidator,
        PlatformTaskTransitionService transitions
    ) {
        this.taskMapper = taskMapper;
        this.runMapper = runMapper;
        this.retryMapper = retryMapper;
        this.relationValidator = relationValidator;
        this.transitions = transitions;
    }

    @Transactional(rollbackFor = Exception.class)
    public RetryOutcome requestRetry(
        long applicationId,
        long taskId,
        PlatformActor actor,
        String reason,
        String requestId
    ) {
        if (actor != PlatformActor.OWNER && actor != PlatformActor.SYSTEM_ADMINISTRATOR) {
            throw new BusinessException(ErrorCode.NO_AUTH_ERROR, "只有 Owner 或 System Administrator 可以请求重试");
        }
        String idempotencyKey = normalizeRequestId(requestId);
        relationValidator.requireActiveApplication(applicationId);
        relationValidator.requireTaskBelongsToApplication(applicationId, taskId);

        PlatformTask task = taskMapper.selectOneById(taskId);
        if (task == null || !PlatformTaskState.FAILED.name().equals(task.getState())) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Task 当前状态不接受重试");
        }
        // D-06 要求冻结基线保持不变。没有基线的 failed Task 无法「不变」，那条路径属于
        // 归一化失败，应由 Owner 提交新 Requirement 而不是重试。
        if (task.getBaselineJson() == null || task.getBaselineJson().isBlank()) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Task 没有冻结基线，重试会让基线语义不成立");
        }
        if (retryMapper.countAcceptedForTask(taskId) > 0) {
            // 已经受理过一次：同一个 failed Task 只能被重试一次，否则 Task 会停在 ready
            // 而所有者以为有一次未处理的失败。
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "该 Task 已被重试过一次");
        }

        PlatformTaskRetryRequest record = new PlatformTaskRetryRequest();
        record.setAppId(applicationId);
        record.setTaskId(taskId);
        record.setRequestId(idempotencyKey);
        record.setActorType(actor.name());
        record.setReason(normalizeReason(reason));
        if (retryMapper.insertSelective(record) != 1) {
            throw new BusinessException(ErrorCode.SYSTEM_ERROR, "重试请求写入失败");
        }

        // actor 记的是 PLATFORM 而不是发起者：D-06 规定 Task 状态只由 Platform Domain 裁决，
        // Owner 的身份已经作为重试事实落在 platform_task_retry_request 里。
        transitions.transition(
            taskId,
            PlatformTaskState.FAILED,
            PlatformTaskState.READY,
            PlatformActor.PLATFORM,
            TaskTransitionConditions.none(),
            "OWNER_RETRY_REQUESTED",
            record.getId().toString(),
            idempotencyKey + "-transition"
        );
        // 次数只算一次：createRun 与回执必须引用同一个 attemptNumber，否则回执会指向一个不存在的 Run。
        int attemptNumber = nextAttemptNumber(taskId);
        PlatformRun run = createRun(applicationId, taskId, attemptNumber);
        return new RetryOutcome(taskId, run.getId(), attemptNumber);
    }

    /** 重试产生新 Run，旧 Run 的终态保持不变——它是上一次尝试的证据，不可改写。 */
    private PlatformRun createRun(long applicationId, long taskId, int attemptNumber) {
        PlatformRun run = new PlatformRun();
        run.setId("run-" + UUID.randomUUID());
        run.setApplicationId(applicationId);
        run.setTaskId(taskId);
        run.setState(PlatformRunState.CREATED.name());
        run.setAttemptNumber(attemptNumber);
        if (runMapper.insertSelective(run) != 1) {
            throw new BusinessException(ErrorCode.SYSTEM_ERROR, "Run 写入失败");
        }
        return run;
    }

    private int nextAttemptNumber(long taskId) {
        PlatformRun latest = runMapper.selectLatestForTask(taskId);
        int next = latest == null || latest.getAttemptNumber() == null ? 1 : latest.getAttemptNumber() + 1;
        if (next < 1) {
            throw new BusinessException(ErrorCode.SYSTEM_ERROR, "重试次数计算不合法");
        }
        return next;
    }

    private String normalizeRequestId(String requestId) {
        if (requestId == null || requestId.isBlank()) {
            return UUID.randomUUID().toString();
        }
        String trimmed = requestId.trim();
        if (trimmed.length() > 40) {
            // 后面还要拼 "-transition"，列宽是 64。
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "请求幂等键过长");
        }
        return trimmed;
    }

    private String normalizeReason(String reason) {
        if (reason == null || reason.isBlank()) {
            return null;
        }
        String flattened = reason.replaceAll("\\s+", " ").trim();
        if (flattened.length() > MAX_REASON_LENGTH) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "重试说明过长");
        }
        return flattened;
    }
}