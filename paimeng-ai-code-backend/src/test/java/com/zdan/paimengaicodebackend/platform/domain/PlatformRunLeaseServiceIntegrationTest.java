package com.zdan.paimengaicodebackend.platform.domain;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
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
import com.zdan.paimengaicodebackend.platform.entity.PlatformRunLeaseEvent;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataAccessException;
import org.springframework.transaction.annotation.Transactional;

/**
 * Lease 是 Run 写入权的权威事实，因此这些断言都打到真实数据库：
 * 唯一约束、append-only 触发器与过期收割都不是应用层可以自证的行为。
 *
 * <p><strong>边界</strong>：本类是 {@code @Transactional} 回滚式，因此<strong>不能</strong>
 * 验证 {@link PlatformRunLeaseAuditor} 的 {@code REQUIRES_NEW} 写入——外层未提交事务既会
 * 挡住 {@code recordExpiry} 的 DELETE 直到锁等待超时（50s），又会让 {@code recordRejection}
 * 在 MVCC 下看不见未提交的 Run 行而静默不写证据。过期收割与拒绝留痕的断言因此放在
 * {@link PlatformRunLeaseAuditIntegrationTest}（非事务）。不要把它们搬回这里。
 */
@SpringBootTest
@Transactional
class PlatformRunLeaseServiceIntegrationTest {

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

    @Test
    void grantsLeaseAndAppendsEvidence() {
        Graph graph = createGraph(1L);

        PlatformRunLease lease = leaseService.grant(
            graph.run().getId(),
            PlatformActor.RUNTIME,
            "RUN_STARTED",
            "grant-1"
        );

        assertNotNull(lease.getId());
        assertEquals(graph.application().getId(), lease.getApplicationId());
        assertEquals(1L, lease.getFenceToken());
        assertEquals(0, lease.getRenewCount());
        assertTrue(lease.getExpiresAt().isAfter(lease.getGrantedAt()));
        assertEquals(1, leaseEventMapper.selectCountByQuery(
            QueryWrapper
                .create()
                .eq("runId", graph.run().getId())
                .eq("eventType", PlatformRunLeaseEventType.GRANTED.name())
        ));
        assertTrue(leaseService.hasActiveLeaseForRun(graph.run().getId()));
        assertTrue(leaseService.hasGrantedLeaseForTask(graph.task().getId()));
    }

    @Test
    void rejectsSecondWriterForSameApplication() {
        Graph graph = createGraph(1L);
        leaseService.grant(graph.run().getId(), PlatformActor.RUNTIME, "RUN_STARTED", "grant-1");
        PlatformRun competingRun = insertRun(graph, "competing");

        assertThrows(BusinessException.class, () -> leaseService.grant(
            competingRun.getId(),
            PlatformActor.RUNTIME,
            "RUN_STARTED",
            "grant-2"
        ));
    }

    @Test
    void rejectsLeaseRequestFromUntrustedActor() {
        Graph graph = createGraph(1L);

        assertThrows(BusinessException.class, () -> leaseService.grant(
            graph.run().getId(),
            PlatformActor.AGENT,
            "RUN_STARTED",
            "grant-agent"
        ));
        assertThrows(BusinessException.class, () -> leaseService.grant(
            graph.run().getId(),
            PlatformActor.OWNER,
            "RUN_STARTED",
            "grant-owner"
        ));
    }

    @Test
    void replayedGrantReturnsSameLeaseInsteadOfSecondToken() {
        Graph graph = createGraph(1L);
        PlatformRunLease first = leaseService.grant(
            graph.run().getId(),
            PlatformActor.RUNTIME,
            "RUN_STARTED",
            "grant-replay"
        );

        PlatformRunLease replayed = leaseService.grant(
            graph.run().getId(),
            PlatformActor.RUNTIME,
            "RUN_STARTED",
            "grant-replay"
        );

        assertEquals(first.getId(), replayed.getId());
        assertEquals(first.getFenceToken(), replayed.getFenceToken());
        assertEquals(1, leaseEventMapper.selectCountByQuery(
            QueryWrapper.create().eq("runId", graph.run().getId())
        ));
    }

    @Test
    void renewsLeaseAndRejectsStaleFenceToken() {
        Graph graph = createGraph(1L);
        PlatformRunLease lease = leaseService.grant(
            graph.run().getId(),
            PlatformActor.RUNTIME,
            "RUN_STARTED",
            "grant-1"
        );

        PlatformRunLease renewed = leaseService.renew(
            graph.run().getId(),
            lease.getFenceToken(),
            PlatformActor.RUNTIME,
            "RUN_ALIVE",
            "renew-1"
        );

        assertEquals(1, renewed.getRenewCount());
        assertThrows(BusinessException.class, () -> leaseService.renew(
            graph.run().getId(),
            lease.getFenceToken() + 99,
            PlatformActor.RUNTIME,
            "RUN_ALIVE",
            "renew-stale"
        ));
    }

    @Test
    void stopsRenewingAfterReachingConfiguredCap() {
        Graph graph = createGraph(1L);
        PlatformRunLease lease = leaseService.grant(
            graph.run().getId(),
            PlatformActor.RUNTIME,
            "RUN_STARTED",
            "grant-1"
        );
        for (int attempt = 1; attempt <= PlatformRunLeaseService.LEASE_MAX_RENEW_COUNT; attempt++) {
            leaseService.renew(
                graph.run().getId(),
                lease.getFenceToken(),
                PlatformActor.RUNTIME,
                "RUN_ALIVE",
                "renew-" + attempt
            );
        }

        assertThrows(BusinessException.class, () -> leaseService.renew(
            graph.run().getId(),
            lease.getFenceToken(),
            PlatformActor.RUNTIME,
            "RUN_ALIVE",
            "renew-over-cap"
        ));
    }

    @Test
    void releaseRemovesActiveRowAndKeepsEvidence() {
        Graph graph = createGraph(1L);
        PlatformRunLease lease = leaseService.grant(
            graph.run().getId(),
            PlatformActor.RUNTIME,
            "RUN_STARTED",
            "grant-1"
        );

        leaseService.release(
            graph.run().getId(),
            lease.getFenceToken(),
            PlatformActor.RUNTIME,
            "RUN_FINISHED",
            "release-1"
        );

        assertEquals(0, leaseMapper.selectCountByQuery(
            QueryWrapper.create().eq("runId", graph.run().getId())
        ));
        assertEquals(1, leaseEventMapper.selectCountByQuery(
            QueryWrapper
                .create()
                .eq("runId", graph.run().getId())
                .eq("eventType", PlatformRunLeaseEventType.RELEASED.name())
        ));
        assertTrue(leaseService.hasNoLeaseForRun(graph.run().getId()));
        assertTrue(leaseService.hasNoActiveLeaseForTask(graph.task().getId()));
    }

    @Test
    void releaseIsIdempotentForReplayedRequest() {
        Graph graph = createGraph(1L);
        PlatformRunLease lease = leaseService.grant(
            graph.run().getId(),
            PlatformActor.RUNTIME,
            "RUN_STARTED",
            "grant-1"
        );
        leaseService.release(
            graph.run().getId(),
            lease.getFenceToken(),
            PlatformActor.RUNTIME,
            "RUN_FINISHED",
            "release-replay"
        );

        leaseService.release(
            graph.run().getId(),
            lease.getFenceToken(),
            PlatformActor.RUNTIME,
            "RUN_FINISHED",
            "release-replay"
        );

        assertEquals(1, leaseEventMapper.selectCountByQuery(
            QueryWrapper
                .create()
                .eq("runId", graph.run().getId())
                .eq("eventType", PlatformRunLeaseEventType.RELEASED.name())
        ));
    }

    @Test
    void leaseEvidenceIsAppendOnly() {
        Graph graph = createGraph(1L);
        leaseService.grant(graph.run().getId(), PlatformActor.RUNTIME, "RUN_STARTED", "grant-1");
        PlatformRunLeaseEvent event = leaseEventMapper.selectOneByQuery(
            QueryWrapper.create().eq("runId", graph.run().getId())
        );
        PlatformRunLeaseEvent update = new PlatformRunLeaseEvent();
        update.setReasonCode("changed");

        assertThrows(DataAccessException.class, () -> leaseEventMapper.updateByQuery(
            update,
            true,
            QueryWrapper.create().eq("id", event.getId())
        ));
        assertThrows(DataAccessException.class, () -> leaseEventMapper.deleteById(event.getId()));
    }

    private PlatformRun insertRun(Graph graph, String suffix) {
        PlatformRun run = new PlatformRun();
        run.setId("run-" + graph.task().getId() + "-" + suffix);
        run.setApplicationId(graph.application().getId());
        run.setTaskId(graph.task().getId());
        run.setState(PlatformRunState.CREATED.name());
        run.setAttemptNumber(2);
        runMapper.insertSelective(run);
        return run;
    }

    private Graph createGraph(long ownerId) {
        App application = new App();
        application.setUserId(ownerId);
        application.setAppName("synthetic lease application");
        application.setCodeGenType("html");
        application.setIsDelete(0);
        application.setLifecycleStatus("ACTIVE");
        appMapper.insertSelective(application);

        PlatformRequirement requirement = new PlatformRequirement();
        requirement.setApplicationId(application.getId());
        requirement.setKind("OWNER_REQUEST");
        requirement.setOriginalText("synthetic requirement");
        requirementMapper.insertSelective(requirement);

        PlatformTask task = new PlatformTask();
        task.setApplicationId(application.getId());
        task.setRequirementId(requirement.getId());
        task.setState(PlatformTaskState.CREATED.name());
        taskMapper.insertSelective(task);

        PlatformRun run = new PlatformRun();
        run.setId("run-" + task.getId());
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
