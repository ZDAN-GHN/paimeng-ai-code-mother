package com.zdan.paimengaicodebackend.platform.validation;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformValidationQueueEventMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformValidationQueueMapper;
import com.zdan.paimengaicodebackend.platform.entity.PlatformValidationQueue;
import com.zdan.paimengaicodebackend.platform.entity.PlatformValidationQueueEvent;
import com.zdan.paimengaicodebackend.platform.snapshot.SnapshotReference;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * 权威验证队列的登记、领取与结果 CAS
 * <p>
 * 队列行与 Run 转换事件由同一个事务写入，数据库不再用触发器代劳业务写入；
 * 触发器只保留无法用 CHECK 表达的旧值比较。
 */
@Service
public class PlatformValidationQueueService {
    private static final List<String> CLAIMABLE_RESULTS =
        List.of("PASS", "FAIL", "INCONCLUSIVE", "CLEANUP_FAILED");

    private final PlatformValidationQueueMapper queueMapper;
    private final PlatformValidationQueueEventMapper eventMapper;

    PlatformValidationQueueService(
        PlatformValidationQueueMapper queueMapper,
        PlatformValidationQueueEventMapper eventMapper
    ) {
        this.queueMapper = queueMapper;
        this.eventMapper = eventMapper;
    }

    record Claim(long eventId, long applicationId, String runId, String attemptId,
                 String replacedAttemptId) { }

    /**
     * 登记待验证的 Run
     * <p>
     * 只允许挂在调用方事务上，保证 Run 成功与队列登记同生共死；
     * 缺失该登记的 Run 会在晋升时被 requirePassed 直接拒绝。
     *
     * @param eventId       Run 转换事件 id
     * @param applicationId 应用 id
     * @param runId         Run id
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public void enqueue(long eventId, long applicationId, String runId) {
        if (eventId <= 0 || applicationId <= 0 || runId == null || runId.isBlank()) throw denied();
        // 注解只在 Spring 代理下生效，直接构造本类时是空操作，这里显式兜住同生共死的前提
        if (!TransactionSynchronizationManager.isActualTransactionActive()) throw denied();
        PlatformValidationQueue row = new PlatformValidationQueue();
        row.setEventId(eventId);
        row.setAppId(applicationId);
        row.setRunId(runId);
        row.setState("PENDING");
        row.setAttemptNumber(0);
        if (queueMapper.insertSelective(row) != 1) throw denied();
        appendEvent(eventId, runId, null, "PENDING", null);
    }

    @Transactional(rollbackFor = Exception.class)
    Optional<Claim> claimNext() {
        PlatformValidationQueue candidate = queueMapper.selectClaimable();
        if (candidate == null) return Optional.empty();
        int previousAttempt = candidate.getAttemptNumber() == null ? 0 : candidate.getAttemptNumber();
        if (previousAttempt == Integer.MAX_VALUE) throw denied();
        String attempt = UUID.randomUUID().toString();
        if (queueMapper.claim(candidate.getEventId(), attempt, previousAttempt + 1) != 1) throw denied();
        appendEvent(candidate.getEventId(), candidate.getRunId(), attempt, "RUNNING", null);
        return Optional.of(new Claim(candidate.getEventId(), candidate.getAppId(), candidate.getRunId(),
            attempt, candidate.getAttemptId()));
    }

    @Transactional(rollbackFor = Exception.class)
    void complete(Claim claim, String state, String reasonCode) {
        if (claim == null || !CLAIMABLE_RESULTS.contains(state)
            || reasonCode == null || !reasonCode.matches("[A-Z][A-Z0-9_]{0,63}")) throw denied();
        if ("PASS".equals(state)
            && queueMapper.countAuthoritativePassEvidence(claim.runId(), claim.attemptId()) != 1) {
            throw denied();
        }
        if (queueMapper.complete(
            claim.eventId(), claim.runId(), claim.attemptId(), state, reasonCode) != 1) throw denied();
        appendEvent(claim.eventId(), claim.runId(), claim.attemptId(), state, reasonCode);
    }

    @Transactional(readOnly = true)
    public String requirePassed(SnapshotReference reference) {
        if (reference == null) throw denied();
        List<String> attempts = queueMapper.selectPassedAttempts(
            reference.applicationId(), reference.runId());
        if (attempts.size() != 1 || attempts.getFirst() == null) throw denied();
        return attempts.getFirst();
    }

    /** 队列事件表是留存证据，只允许追加；写入方必须与队列行处于同一事务 */
    private void appendEvent(long eventId, String runId, String attemptId, String state, String reasonCode) {
        PlatformValidationQueueEvent event = new PlatformValidationQueueEvent();
        event.setEventId(eventId);
        event.setRunId(runId);
        event.setAttemptId(attemptId);
        event.setToState(state);
        event.setReasonCode(reasonCode);
        if (eventMapper.insertSelective(event) != 1) throw denied();
    }

    private BusinessException denied() {
        return new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Validation 队列状态或权威证明不满足");
    }
}
