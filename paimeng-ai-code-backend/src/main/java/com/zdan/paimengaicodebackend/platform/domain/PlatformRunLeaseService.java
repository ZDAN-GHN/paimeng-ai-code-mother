package com.zdan.paimengaicodebackend.platform.domain;

import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunLeaseEventMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunLeaseMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRun;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRunLease;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRunLeaseEvent;
import java.time.LocalDateTime;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Platform 对 Run 写入权的权威裁决。
 *
 * <p>活跃 Lease 是 {@code platform_run_lease} 的单行事实，由 {@code UNIQUE(appId)} 保证
 * 每个 Application 最多一个写入者。调用方不能自报持有 Lease——Task 与 Run 状态转换均从本
 * 服务查询真实行（D-06：Platform 是唯一裁决方）。
 *
 * <p>fenceToken 在 Application 内单调递增，用于拒绝过期写入者：Lease 过期后被新持有者取代，
 * 旧持有者携带的 fence 落后即被拒绝。
 */
@Slf4j
@Service
public class PlatformRunLeaseService {

    /** Lease 存活时长；维护者决策值。 */
    public static final long LEASE_TTL_SECONDS = 60L;

    /** 建议续租间隔；作为能力提示下发给 Runtime，不在服务端强制。 */
    public static final long LEASE_RENEW_INTERVAL_SECONDS = 20L;

    /** 单个 Lease 的最大续租次数。 */
    public static final int LEASE_MAX_RENEW_COUNT = 3;

    private static final Set<PlatformActor> LEASE_REQUESTING_ACTORS = Set.of(
        PlatformActor.RUNTIME,
        PlatformActor.PLATFORM
    );

    private static final Set<PlatformActor> LEASE_RELEASING_ACTORS = Set.of(
        PlatformActor.RUNTIME,
        PlatformActor.PLATFORM,
        PlatformActor.OWNER,
        PlatformActor.SYSTEM_ADMINISTRATOR
    );

    private final PlatformRunLeaseMapper leaseMapper;
    private final PlatformRunLeaseEventMapper leaseEventMapper;
    private final PlatformRunMapper runMapper;
    private final PlatformLogicalRelationValidator relationValidator;
    private final PlatformRunLeaseAuditor auditor;

    public PlatformRunLeaseService(
        PlatformRunLeaseMapper leaseMapper,
        PlatformRunLeaseEventMapper leaseEventMapper,
        PlatformRunMapper runMapper,
        PlatformLogicalRelationValidator relationValidator,
        PlatformRunLeaseAuditor auditor
    ) {
        this.leaseMapper = leaseMapper;
        this.leaseEventMapper = leaseEventMapper;
        this.runMapper = runMapper;
        this.relationValidator = relationValidator;
        this.auditor = auditor;
    }

    /**
     * 为 Run 申请写入 Lease。Application 内已有未过期 Lease 时拒绝；已过期的 Lease 行在本次
     * 调用中被收割（删除 + EXPIRED 事件），其证据保留在事件表。
     */
    @Transactional(rollbackFor = Exception.class)
    public PlatformRunLease grant(
        String runId,
        PlatformActor requestedBy,
        String reasonCode,
        String requestId
    ) {
        long startedNanos = System.nanoTime();
        requireRequestParams(runId, requestId);
        requireActor(requestedBy, LEASE_REQUESTING_ACTORS, "无权申请 Lease");

        PlatformRun run = requireRunWithVerifiedRelations(runId);
        PlatformRunLease replayed = findReplayedLease(runId, PlatformRunLeaseEventType.GRANTED, requestId);
        if (replayed != null) {
            return replayed;
        }

        LocalDateTime now = LocalDateTime.now();
        reapExpiredLease(run.getApplicationId(), now, requestId);

        PlatformRunLease active = findActiveLeaseByApplication(run.getApplicationId());
        if (active != null) {
            throw new BusinessException(
                ErrorCode.FORBIDDEN_ERROR,
                "Application 已有活跃写入 Lease，不能重复授予"
            );
        }

        PlatformRunLease lease = new PlatformRunLease();
        lease.setApplicationId(run.getApplicationId());
        lease.setRunId(runId);
        lease.setTaskId(run.getTaskId());
        lease.setFenceToken(nextFenceToken(run.getApplicationId()));
        lease.setGrantedAt(now);
        lease.setExpiresAt(now.plusSeconds(LEASE_TTL_SECONDS));
        lease.setRenewCount(0);
        leaseMapper.insert(lease);

        appendEvent(lease, PlatformRunLeaseEventType.GRANTED, requestedBy, reasonCode, requestId, now);
        logCompleted("grant", lease, requestId, startedNanos);
        return lease;
    }

    /**
     * 续租。fence 落后、Lease 已过期或已达续租上限均拒绝。
     */
    @Transactional(rollbackFor = Exception.class)
    public PlatformRunLease renew(
        String runId,
        long fenceToken,
        PlatformActor requestedBy,
        String reasonCode,
        String requestId
    ) {
        long startedNanos = System.nanoTime();
        requireRequestParams(runId, requestId);
        requireActor(requestedBy, LEASE_REQUESTING_ACTORS, "无权续租 Lease");

        PlatformRunLease replayed = findReplayedLease(runId, PlatformRunLeaseEventType.RENEWED, requestId);
        if (replayed != null) {
            return replayed;
        }

        LocalDateTime now = LocalDateTime.now();
        PlatformRunLease lease = requireLeaseHeldBy(runId, fenceToken, now, requestId);
        if (lease.getRenewCount() >= LEASE_MAX_RENEW_COUNT) {
            throw new BusinessException(
                ErrorCode.FORBIDDEN_ERROR,
                "Lease 续租次数已达上限 " + LEASE_MAX_RENEW_COUNT
            );
        }

        PlatformRunLease update = new PlatformRunLease();
        update.setExpiresAt(now.plusSeconds(LEASE_TTL_SECONDS));
        update.setRenewCount(lease.getRenewCount() + 1);
        if (leaseMapper.updateByQuery(
            update,
            true,
            QueryWrapper
                .create()
                .eq("runId", runId)
                .eq("fenceToken", fenceToken)
                .eq("renewCount", lease.getRenewCount())
        ) != 1) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Lease 已变化，续租失败");
        }
        lease.setExpiresAt(update.getExpiresAt());
        lease.setRenewCount(update.getRenewCount());

        appendEvent(lease, PlatformRunLeaseEventType.RENEWED, requestedBy, reasonCode, requestId, now);
        logCompleted("renew", lease, requestId, startedNanos);
        return lease;
    }

    /**
     * 释放 Lease。删除活跃行，证据落 RELEASED 事件。重放同一 requestId 视为成功。
     */
    @Transactional(rollbackFor = Exception.class)
    public void release(
        String runId,
        long fenceToken,
        PlatformActor requestedBy,
        String reasonCode,
        String requestId
    ) {
        long startedNanos = System.nanoTime();
        requireRequestParams(runId, requestId);
        requireActor(requestedBy, LEASE_RELEASING_ACTORS, "无权释放 Lease");

        if (hasEvent(runId, PlatformRunLeaseEventType.RELEASED, requestId)) {
            return;
        }

        LocalDateTime now = LocalDateTime.now();
        PlatformRunLease lease = requireLeaseHeldBy(runId, fenceToken, now, requestId);
        if (leaseMapper.deleteByQuery(
            QueryWrapper.create().eq("runId", runId).eq("fenceToken", fenceToken)
        ) != 1) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Lease 已变化，释放失败");
        }

        appendEvent(lease, PlatformRunLeaseEventType.RELEASED, requestedBy, reasonCode, requestId, now);
        logCompleted("release", lease, requestId, startedNanos);
    }

    /**
     * 校验调用方确实持有该 Run 的有效 Lease。过期 Lease 在此被收割并拒绝，
     * 使「校验通过后过期」不会变成允许写入。
     */
    @Transactional(rollbackFor = Exception.class)
    public PlatformRunLease requireHeldLease(String runId, long fenceToken, String requestId) {
        requireRequestParams(runId, requestId);
        return requireLeaseHeldBy(runId, fenceToken, LocalDateTime.now(), requestId);
    }

    /** Task 是否存在「已创建 Run 且已授予 Lease」的真实事实。 */
    public boolean hasGrantedLeaseForTask(Long taskId) {
        if (taskId == null) {
            return false;
        }
        return leaseMapper.selectCountByQuery(
            QueryWrapper
                .create()
                .eq("taskId", taskId)
                .ge("expiresTime", LocalDateTime.now())
        ) > 0;
    }

    /** Task 是否已无任何活跃 Lease（Run 已停止且 Lease 已释放）。 */
    public boolean hasNoActiveLeaseForTask(Long taskId) {
        if (taskId == null) {
            return true;
        }
        return leaseMapper.selectCountByQuery(QueryWrapper.create().eq("taskId", taskId)) == 0;
    }

    /** Run 当前是否持有活跃 Lease。 */
    public boolean hasActiveLeaseForRun(String runId) {
        if (runId == null || runId.isBlank()) {
            return false;
        }
        return leaseMapper.selectCountByQuery(
            QueryWrapper
                .create()
                .eq("runId", runId)
                .ge("expiresTime", LocalDateTime.now())
        ) > 0;
    }

    /** Run 是否已无 Lease 行（已释放或从未授予）。 */
    public boolean hasNoLeaseForRun(String runId) {
        if (runId == null || runId.isBlank()) {
            return true;
        }
        return leaseMapper.selectCountByQuery(QueryWrapper.create().eq("runId", runId)) == 0;
    }

    /**
     * Application 当前是否存在活跃写入 Lease。
     *
     * <p>归档判据不能只看 Run 状态：Lease 在 {@code CREATED→LEASED} 之前授予，
     * 该窗口内 Run 仍是 CREATED 但写入权已发出，只看状态会漏判。
     */
    public boolean hasActiveLeaseForApplication(Long applicationId) {
        if (applicationId == null) {
            return false;
        }
        return leaseMapper.selectCountByQuery(
            QueryWrapper
                .create()
                .eq("appId", applicationId)
                .ge("expiresTime", LocalDateTime.now())
        ) > 0;
    }

    private PlatformRunLease requireLeaseHeldBy(
        String runId,
        long fenceToken,
        LocalDateTime now,
        String requestId
    ) {
        PlatformRunLease lease = leaseMapper.selectOneByQuery(
            QueryWrapper.create().eq("runId", runId)
        );
        if (lease == null) {
            recordRejectionSafely(
                runId,
                fenceToken,
                PlatformRunLeaseRejectionReason.LEASE_ABSENT,
                requestId,
                now
            );
            throw new BusinessException(ErrorCode.NOT_FOUND_ERROR, "Run 未持有 Lease");
        }
        if (lease.getFenceToken() == null || lease.getFenceToken() != fenceToken) {
            recordRejectionSafely(
                runId,
                fenceToken,
                PlatformRunLeaseRejectionReason.LEASE_FENCE_STALE,
                requestId,
                now
            );
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Lease fence token 已过期");
        }
        if (lease.getExpiresAt() == null || lease.getExpiresAt().isBefore(now)) {
            // 两个独立事实：Lease 被收割（生命周期）+ 本次写入尝试被拒（尝试）。
            // 只写前者会让「有多少次过期写入被拒」无法回答——收割也可能由 grant 触发，
            // 那时并没有谁被拒绝。
            recordExpirySafely(lease, requestId, now);
            recordRejectionSafely(
                runId,
                fenceToken,
                PlatformRunLeaseRejectionReason.LEASE_TTL_ELAPSED,
                requestId,
                now
            );
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Lease 已过期");
        }
        return lease;
    }

    private void reapExpiredLease(Long applicationId, LocalDateTime now, String requestId) {
        PlatformRunLease expired = leaseMapper.selectOneByQuery(
            QueryWrapper.create().eq("appId", applicationId).lt("expiresTime", now)
        );
        if (expired != null) {
            // 此处没有待抛的拒绝原因，收割失败就让它大声失败：静默跳过会让随后的 INSERT
            // 撞上 UNIQUE(appId)，错误现场离根因更远。
            auditor.recordExpiry(expired, requestId, now);
        }
    }

    /** Application 当前的未过期 Lease 行；无则返回 null。 */
    private PlatformRunLease findActiveLeaseByApplication(Long applicationId) {
        return leaseMapper.selectOneByQuery(
            QueryWrapper
                .create()
                .eq("appId", applicationId)
                .ge("expiresTime", LocalDateTime.now())
        );
    }

    /**
     * 在已确定要拒绝调用方的路径上记录收割。
     *
     * <p>吞掉审计异常是刻意的：此刻已有一个真实的拒绝原因要抛给调用方，用审计故障覆盖它会
     * 丢掉首个根因（{@code .agents/rules/errors.md}）。收割没成功的后果是这行过期 Lease
     * 多活一会儿，下次 {@code grant} 的 reap 会再收一遍——可重试、不丢正确性。
     */
    private void recordExpirySafely(PlatformRunLease lease, String requestId, LocalDateTime now) {
        try {
            auditor.recordExpiry(lease, requestId, now);
        } catch (RuntimeException auditFailure) {
            log.error(
                "Platform Run lease expiry audit failed, runId: {}, fenceToken: {}, requestId: {}, errorClass: {}, result: rejection-still-enforced",
                lease.getRunId(),
                lease.getFenceToken(),
                requestId,
                auditFailure.getClass().getSimpleName(),
                auditFailure
            );
        }
    }

    /**
     * 记录一次被拒绝的写入尝试。
     *
     * <p>同样吞掉审计异常：拒绝本身必须照旧生效。<strong>审计缺失不得反过来变成放行。</strong>
     */
    private void recordRejectionSafely(
        String runId,
        long presentedFenceToken,
        PlatformRunLeaseRejectionReason reason,
        String requestId,
        LocalDateTime now
    ) {
        try {
            auditor.recordRejection(runId, presentedFenceToken, reason, requestId, now);
        } catch (RuntimeException auditFailure) {
            log.error(
                "Platform Run lease rejection audit failed, runId: {}, presentedFenceToken: {}, reason: {}, requestId: {}, errorClass: {}, result: rejection-still-enforced",
                runId,
                presentedFenceToken,
                reason,
                requestId,
                auditFailure.getClass().getSimpleName(),
                auditFailure
            );
        }
    }

    /**
     * 下一个 fence token = 本 Application 事件历史最大值 + 1。事件表 append-only，
     * 因此该值单调；并发授予被 {@code UNIQUE(appId)} 串行化，失败方整事务回滚，
     * 不会留下重复 fence。
     */
    private long nextFenceToken(Long applicationId) {
        PlatformRunLeaseEvent latest = leaseEventMapper.selectOneByQuery(
            QueryWrapper
                .create()
                .eq("appId", applicationId)
                .orderBy("fenceToken", false)
                .limit(1)
        );
        if (latest == null || latest.getFenceToken() == null) {
            return 1L;
        }
        return latest.getFenceToken() + 1;
    }

    private PlatformRun requireRunWithVerifiedRelations(String runId) {
        PlatformRun run = runMapper.selectOneByQuery(QueryWrapper.create().eq("id", runId));
        if (run == null) {
            throw new BusinessException(ErrorCode.NOT_FOUND_ERROR, "Run 不存在");
        }
        relationValidator.requireActiveApplication(run.getApplicationId());
        relationValidator.requireTaskBelongsToApplication(run.getApplicationId(), run.getTaskId());
        relationValidator.requireRunBelongsToApplication(run.getApplicationId(), runId);
        return run;
    }

    private PlatformRunLease findReplayedLease(
        String runId,
        PlatformRunLeaseEventType eventType,
        String requestId
    ) {
        if (!hasEvent(runId, eventType, requestId)) {
            return null;
        }
        PlatformRunLease lease = leaseMapper.selectOneByQuery(
            QueryWrapper.create().eq("runId", runId)
        );
        if (lease == null) {
            throw new BusinessException(
                ErrorCode.FORBIDDEN_ERROR,
                "Lease 已释放或过期，不能以同一 requestId 重放"
            );
        }
        return lease;
    }

    private boolean hasEvent(String runId, PlatformRunLeaseEventType eventType, String requestId) {
        return leaseEventMapper.selectCountByQuery(
            QueryWrapper
                .create()
                .eq("runId", runId)
                .eq("eventType", eventType.name())
                .eq("requestId", requestId)
        ) > 0;
    }

    private void appendEvent(
        PlatformRunLease lease,
        PlatformRunLeaseEventType eventType,
        PlatformActor actor,
        String reasonCode,
        String requestId,
        LocalDateTime occurredAt
    ) {
        PlatformRunLeaseEvent event = new PlatformRunLeaseEvent();
        event.setApplicationId(lease.getApplicationId());
        event.setRunId(lease.getRunId());
        event.setTaskId(lease.getTaskId());
        event.setEventType(eventType.name());
        event.setFenceToken(lease.getFenceToken());
        event.setActorType(actor.name());
        event.setReasonCode(reasonCode);
        event.setRequestId(requestId);
        event.setOccurredAt(occurredAt);
        leaseEventMapper.insert(event);
    }

    private void requireRequestParams(String runId, String requestId) {
        if (runId == null || runId.isBlank() || requestId == null || requestId.isBlank()) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "Lease 操作参数不完整");
        }
    }

    private void requireActor(PlatformActor actor, Set<PlatformActor> allowed, String message) {
        if (actor == null || !allowed.contains(actor)) {
            throw new BusinessException(ErrorCode.NO_AUTH_ERROR, message);
        }
    }

    private void logCompleted(
        String operation,
        PlatformRunLease lease,
        String requestId,
        long startedNanos
    ) {
        log.info(
            "Platform Run lease {} completed, applicationId: {}, runId: {}, taskId: {}, fenceToken: {}, renewCount: {}, requestId: {}, result: success, durationMs: {}",
            operation,
            lease.getApplicationId(),
            lease.getRunId(),
            lease.getTaskId(),
            lease.getFenceToken(),
            lease.getRenewCount(),
            requestId,
            TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos)
        );
    }
}
