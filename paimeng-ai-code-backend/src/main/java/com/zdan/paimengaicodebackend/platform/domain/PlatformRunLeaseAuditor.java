package com.zdan.paimengaicodebackend.platform.domain;

import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunLeaseEventMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunLeaseMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRun;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRunLease;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRunLeaseEvent;
import java.time.LocalDateTime;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Lease 审计写入器。存在的唯一理由是<strong>事务边界</strong>。
 *
 * <p>被拒绝的写入尝试和被收割的过期 Lease 都是必须留痕的事实，而记录它们的调用紧接着就要
 * 抛异常拒绝调用方。若审计写在调用方事务内，{@code BusinessException}（RuntimeException）
 * 会把刚写下的证据一并回滚——证据恰好在最需要它的路径上消失。
 *
 * <p>因此这里的方法一律 {@code REQUIRES_NEW}：在独立事务中提交，不受调用方回滚影响。
 * 这也是本类必须是独立 bean 的原因——同类内自调用不经过 Spring 代理，propagation 不生效。
 *
 * <p><strong>调用方不变式</strong>：独立事务跑在另一条连接上，因此调用方在调用本类之前
 * <strong>不得持有</strong> {@code platform_run_lease} 目标行的写锁，也不得依赖本类看见
 * 调用方尚未提交的行。{@code recordExpiry} 自己就 DELETE 该表，一旦调用方已持锁，
 * 两个事务会互等到 {@code innodb_lock_wait_timeout}（默认 50s）——InnoDB 看不出这是
 * 应用层环，不会报死锁，只会超时。
 *
 * <p>现状核对：{@code PlatformRunLeaseService} 的四条路径都用非锁定读
 * {@code selectOneByQuery} 定位 Lease，调用本类时未持有写锁，故不变式成立。
 * 引入 {@code SELECT ... FOR UPDATE} 或调整调用点顺序前须重新核对。
 *
 * <p>由此推出的测试约束：验证本类写入的测试<strong>不能</strong>是
 * {@code @Transactional} 回滚式。外层未提交事务既会挡住 {@code recordExpiry} 的 DELETE，
 * 又会让 {@code recordRejection} 在 MVCC 下看不见 Run 行而静默走 run-unresolvable 分支。
 * 相关断言见 {@code PlatformRunLeaseAuditIntegrationTest}（非事务）。
 */
@Slf4j
@Component
public class PlatformRunLeaseAuditor {

    private final PlatformRunLeaseMapper leaseMapper;
    private final PlatformRunLeaseEventMapper leaseEventMapper;
    private final PlatformRunMapper runMapper;

    public PlatformRunLeaseAuditor(
        PlatformRunLeaseMapper leaseMapper,
        PlatformRunLeaseEventMapper leaseEventMapper,
        PlatformRunMapper runMapper
    ) {
        this.leaseMapper = leaseMapper;
        this.leaseEventMapper = leaseEventMapper;
        this.runMapper = runMapper;
    }

    /**
     * 收割过期 Lease：删除活跃行并写 {@code EXPIRED} 证据，独立提交。
     *
     * <p>删除与事件必须同事务——只删不留痕会让 Lease 凭空消失。二者一起独立于调用方提交，
     * 因此「TTL 已过」这个事实无论调用方随后成功还是被拒都成立。
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW, rollbackFor = Exception.class)
    public void recordExpiry(PlatformRunLease lease, String requestId, LocalDateTime occurredAt) {
        if (leaseMapper.deleteByQuery(
            QueryWrapper
                .create()
                .eq("runId", lease.getRunId())
                .eq("fenceToken", lease.getFenceToken())
        ) != 1) {
            // 已被并发收割：对方的事务会写下同一事实，这里不重复记录。
            return;
        }
        appendEvent(
            lease.getApplicationId(),
            lease.getRunId(),
            lease.getTaskId(),
            PlatformRunLeaseEventType.EXPIRED,
            lease.getFenceToken(),
            PlatformActor.PLATFORM,
            PlatformRunLeaseRejectionReason.LEASE_TTL_ELAPSED.name(),
            requestId,
            occurredAt
        );
        log.info(
            "Platform Run lease expired, applicationId: {}, runId: {}, fenceToken: {}, requestId: {}, result: reaped",
            lease.getApplicationId(),
            lease.getRunId(),
            lease.getFenceToken(),
            requestId
        );
    }

    /**
     * 记录一次被拒绝的写入尝试，独立提交。
     *
     * <p>{@code presentedFenceToken} 记的是<strong>调用方出示的</strong> token，不是当前有效
     * token——「谁拿着哪个过期凭据试图写入」才是这条证据的价值。
     *
     * <p>Lease 行可能已不存在（正是最需要留痕的情形），此时 appId / taskId 从 Run 取。
     * Run 也不存在则无法满足事件表的 NOT NULL 约束，只记日志：此时调用方连 Run 都没有，
     * 不存在跨 Application 写入风险。
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW, rollbackFor = Exception.class)
    public void recordRejection(
        String runId,
        long presentedFenceToken,
        PlatformRunLeaseRejectionReason reason,
        String requestId,
        LocalDateTime occurredAt
    ) {
        PlatformRun run = runMapper.selectOneByQuery(QueryWrapper.create().eq("id", runId));
        if (run == null || run.getApplicationId() == null || run.getTaskId() == null) {
            log.warn(
                "Platform Run lease rejection not recorded, runId: {}, presentedFenceToken: {}, reason: {}, requestId: {}, result: run-unresolvable",
                runId,
                presentedFenceToken,
                reason,
                requestId
            );
            return;
        }
        // 同一 requestId 的重复拒绝是同一个事实，唯一键 (runId, eventType, requestId) 已去重；
        // 先查再写避免把去重变成异常路径。
        if (hasRejectionEvent(runId, requestId)) {
            return;
        }
        appendEvent(
            run.getApplicationId(),
            runId,
            run.getTaskId(),
            PlatformRunLeaseEventType.REJECTED,
            presentedFenceToken,
            PlatformActor.PLATFORM,
            reason.name(),
            requestId,
            occurredAt
        );
        log.warn(
            "Platform Run lease write rejected, applicationId: {}, runId: {}, presentedFenceToken: {}, reason: {}, requestId: {}, result: rejected",
            run.getApplicationId(),
            runId,
            presentedFenceToken,
            reason,
            requestId
        );
    }

    private boolean hasRejectionEvent(String runId, String requestId) {
        return leaseEventMapper.selectCountByQuery(
            QueryWrapper
                .create()
                .eq("runId", runId)
                .eq("eventType", PlatformRunLeaseEventType.REJECTED.name())
                .eq("requestId", requestId)
        ) > 0;
    }

    private void appendEvent(
        Long applicationId,
        String runId,
        Long taskId,
        PlatformRunLeaseEventType eventType,
        Long fenceToken,
        PlatformActor actor,
        String reasonCode,
        String requestId,
        LocalDateTime occurredAt
    ) {
        PlatformRunLeaseEvent event = new PlatformRunLeaseEvent();
        event.setApplicationId(applicationId);
        event.setRunId(runId);
        event.setTaskId(taskId);
        event.setEventType(eventType.name());
        event.setFenceToken(fenceToken);
        event.setActorType(actor.name());
        event.setReasonCode(reasonCode);
        event.setRequestId(requestId);
        event.setOccurredAt(occurredAt);
        leaseEventMapper.insert(event);
    }
}
