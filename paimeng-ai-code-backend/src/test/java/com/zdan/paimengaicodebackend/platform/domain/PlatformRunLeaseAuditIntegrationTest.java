package com.zdan.paimengaicodebackend.platform.domain;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.mapper.AppMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRequirementMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunLeaseEventMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunLeaseMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRequirement;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRun;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRunLease;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

/**
 * Lease 审计证据的<strong>持久性</strong>（Issue #77 / T-05，计划步骤 29）。
 *
 * <p>本类刻意<strong>不加</strong> {@code @Transactional}。审计写入走
 * {@code REQUIRES_NEW}（见 {@link PlatformRunLeaseAuditor}），它跑在另一条连接上：
 * 回滚式测试的外层事务既会挡住 {@code recordExpiry} 的 DELETE 直到锁等待超时，又会让
 * {@code recordRejection} 在 MVCC 下看不见未提交的 Run 行而静默不写证据。也就是说
 * 「证据在调用方回滚后仍然存在」这一条，<strong>只能</strong>在真实提交的数据上验证。
 *
 * <p>代价是诚实记录的：每个用例会留下 1 组 requirement / task / run 行与对应事件行。
 * 这些表由 append-only 触发器保护、设计上就不可删（{@code PlatformMigrationTest} 有断言），
 * 因此 {@link #cleanUp()} 只能清掉可删的 Lease 行并软删 App。本地 dev 库可用
 * {@code docker compose down -v} 整体重建。
 */
@SpringBootTest
class PlatformRunLeaseAuditIntegrationTest {

    @Autowired
    private AppMapper appMapper;

    @Autowired
    private PlatformRequirementMapper requirementMapper;

    @Autowired
    private PlatformTaskMapper taskMapper;

    @Autowired
    private PlatformRunMapper runMapper;

    @Autowired
    private PlatformRunLeaseMapper leaseMapper;

    @Autowired
    private PlatformRunLeaseEventMapper leaseEventMapper;

    @Autowired
    private PlatformRunLeaseService leaseService;

    private final List<Long> createdApplicationIds = new ArrayList<>();

    @AfterEach
    void cleanUp() {
        for (Long applicationId : createdApplicationIds) {
            leaseMapper.deleteByQuery(QueryWrapper.create().eq("appId", applicationId));
            App softDeleted = new App();
            softDeleted.setId(applicationId);
            softDeleted.setIsDelete(1);
            appMapper.update(softDeleted);
        }
        createdApplicationIds.clear();
    }

    /**
     * 这是缺陷 B 的回归守卫：审计写入若留在调用方事务内，紧随其后的
     * {@code BusinessException} 会把刚写下的证据一起回滚——证据恰好在最需要它的路径上消失。
     */
    @Test
    void rejectionEvidenceSurvivesCallerRollback() {
        Graph graph = createGraph();
        PlatformRunLease lease = leaseService.grant(
            graph.run().getId(),
            PlatformActor.RUNTIME,
            "RUN_STARTED",
            "audit-grant-1"
        );
        long staleToken = lease.getFenceToken() - 1;

        assertThrows(BusinessException.class, () -> leaseService.requireHeldLease(
            graph.run().getId(),
            staleToken,
            "audit-stale-1"
        ));

        assertEquals(1, leaseEventMapper.selectCountByQuery(
            QueryWrapper
                .create()
                .eq("runId", graph.run().getId())
                .eq("eventType", PlatformRunLeaseEventType.REJECTED.name())
                .eq("requestId", "audit-stale-1")
                .eq("reasonCode", PlatformRunLeaseRejectionReason.LEASE_FENCE_STALE.name())
        ));
        // 出示的是调用方那个过期 token，不是当前有效 token——否则无法回答「谁拿着什么试图写入」
        assertEquals(1, leaseEventMapper.selectCountByQuery(
            QueryWrapper
                .create()
                .eq("runId", graph.run().getId())
                .eq("requestId", "audit-stale-1")
                .eq("fenceToken", staleToken)
        ));
        // 拒绝不得动摇当前持有者
        assertEquals(1, leaseMapper.selectCountByQuery(
            QueryWrapper.create().eq("runId", graph.run().getId()).eq("fenceToken", lease.getFenceToken())
        ));
    }

    /** 同一 requestId 的重放拒绝是同一个事实，不得累积成多条证据。 */
    @Test
    void replayedRejectionRecordsEvidenceOnce() {
        Graph graph = createGraph();
        leaseService.grant(graph.run().getId(), PlatformActor.RUNTIME, "RUN_STARTED", "audit-grant-2");

        for (int attempt = 0; attempt < 3; attempt++) {
            assertThrows(BusinessException.class, () -> leaseService.requireHeldLease(
                graph.run().getId(),
                999L,
                "audit-replay-1"
            ));
        }

        assertEquals(1, leaseEventMapper.selectCountByQuery(
            QueryWrapper
                .create()
                .eq("runId", graph.run().getId())
                .eq("eventType", PlatformRunLeaseEventType.REJECTED.name())
                .eq("requestId", "audit-replay-1")
        ));
    }

    /**
     * 过期写入尝试要留下两条独立事实：Lease 被收割（生命周期）+ 本次尝试被拒（尝试）。
     * 只写前者会让「有多少次过期写入被拒」无法回答——收割也可能由 grant 触发，那时无人被拒。
     */
    @Test
    void expiredWriteAttemptRecordsBothReapAndRejection() {
        Graph graph = createGraph();
        PlatformRunLease lease = leaseService.grant(
            graph.run().getId(),
            PlatformActor.RUNTIME,
            "RUN_STARTED",
            "audit-grant-3"
        );
        expire(graph.run().getId());

        assertThrows(BusinessException.class, () -> leaseService.requireHeldLease(
            graph.run().getId(),
            lease.getFenceToken(),
            "audit-expired-1"
        ));

        assertEquals(1, leaseEventMapper.selectCountByQuery(
            QueryWrapper
                .create()
                .eq("runId", graph.run().getId())
                .eq("eventType", PlatformRunLeaseEventType.EXPIRED.name())
        ));
        assertEquals(1, leaseEventMapper.selectCountByQuery(
            QueryWrapper
                .create()
                .eq("runId", graph.run().getId())
                .eq("eventType", PlatformRunLeaseEventType.REJECTED.name())
                .eq("reasonCode", PlatformRunLeaseRejectionReason.LEASE_TTL_ELAPSED.name())
        ));
        // 收割必须真的删掉活跃行，否则后续 grant 会撞 UNIQUE(appId)
        assertEquals(0, leaseMapper.selectCountByQuery(
            QueryWrapper.create().eq("runId", graph.run().getId())
        ));
    }

    /**
     * 从 {@code PlatformRunLeaseServiceIntegrationTest} 迁移而来：该类是 {@code @Transactional}
     * 回滚式，reap 路径的 DELETE 会与外层未提交事务互等到锁超时（50s），断言从未真正生效。
     */
    @Test
    void reapedExpiredLeaseLetsNextHolderGetHigherFenceToken() {
        Graph graph = createGraph();
        PlatformRunLease stale = leaseService.grant(
            graph.run().getId(),
            PlatformActor.RUNTIME,
            "RUN_STARTED",
            "audit-grant-4"
        );
        expire(graph.run().getId());
        PlatformRun nextRun = insertRun(graph, "next");

        PlatformRunLease fresh = leaseService.grant(
            nextRun.getId(),
            PlatformActor.RUNTIME,
            "RUN_STARTED",
            "audit-grant-5"
        );

        // fence 单调：收割后的新持有者必须拿到更大的 token，否则被欺骗的旧写入者可重新获权
        assertTrue(fresh.getFenceToken() > stale.getFenceToken());
        assertEquals(1, leaseEventMapper.selectCountByQuery(
            QueryWrapper
                .create()
                .eq("runId", graph.run().getId())
                .eq("eventType", PlatformRunLeaseEventType.EXPIRED.name())
        ));
        assertEquals(0, leaseMapper.selectCountByQuery(
            QueryWrapper.create().eq("runId", graph.run().getId())
        ));
    }

    /**
     * 从 {@code PlatformRunLeaseServiceIntegrationTest} 迁移而来：在那里 reap 的锁超时被
     * {@code recordExpirySafely} 吞掉，用例「通过」但耗时 50s，且 EXPIRED 证据实际未写。
     */
    @Test
    void expiredHolderCannotRenewOrBeTreatedAsHolder() {
        Graph graph = createGraph();
        PlatformRunLease lease = leaseService.grant(
            graph.run().getId(),
            PlatformActor.RUNTIME,
            "RUN_STARTED",
            "audit-grant-6"
        );
        expire(graph.run().getId());

        assertThrows(BusinessException.class, () -> leaseService.renew(
            graph.run().getId(),
            lease.getFenceToken(),
            PlatformActor.RUNTIME,
            "RUN_ALIVE",
            "audit-renew-expired"
        ));
        assertThrows(BusinessException.class, () -> leaseService.requireHeldLease(
            graph.run().getId(),
            lease.getFenceToken(),
            "audit-verify-expired"
        ));
    }

    private void expire(String runId) {
        PlatformRunLease expired = new PlatformRunLease();
        expired.setExpiresAt(LocalDateTime.now().minusSeconds(1));
        leaseMapper.updateByQuery(expired, true, QueryWrapper.create().eq("runId", runId));
    }

    private PlatformRun insertRun(Graph graph, String suffix) {
        PlatformRun run = new PlatformRun();
        run.setId("run-audit-" + graph.task().getId() + "-" + suffix);
        run.setApplicationId(graph.application().getId());
        run.setTaskId(graph.task().getId());
        run.setState(PlatformRunState.CREATED.name());
        run.setAttemptNumber(2);
        runMapper.insertSelective(run);
        return run;
    }

    private Graph createGraph() {
        App application = new App();
        application.setUserId(1L);
        application.setAppName("synthetic lease audit application");
        application.setCodeGenType("html");
        application.setIsDelete(0);
        application.setLifecycleStatus("ACTIVE");
        appMapper.insertSelective(application);
        createdApplicationIds.add(application.getId());

        PlatformRequirement requirement = new PlatformRequirement();
        requirement.setApplicationId(application.getId());
        requirement.setKind("OWNER_REQUEST");
        requirement.setOriginalText("synthetic audit requirement");
        requirementMapper.insertSelective(requirement);

        PlatformTask task = new PlatformTask();
        task.setApplicationId(application.getId());
        task.setRequirementId(requirement.getId());
        task.setState(PlatformTaskState.CREATED.name());
        taskMapper.insertSelective(task);

        PlatformRun run = new PlatformRun();
        run.setId("run-audit-" + task.getId());
        run.setApplicationId(application.getId());
        run.setTaskId(task.getId());
        run.setState(PlatformRunState.CREATED.name());
        run.setAttemptNumber(1);
        runMapper.insertSelective(run);
        return new Graph(application, requirement, task, run);
    }

    private record Graph(
        App application,
        PlatformRequirement requirement,
        PlatformTask task,
        PlatformRun run
    ) {}
}
