package com.zdan.paimengaicodebackend.platform.domain;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.mapper.AppMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformApplicationLifecycleEventMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRequirementMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunTransitionEventMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskTransitionEventMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformValidationQueueEventMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformValidationQueueMapper;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.platform.entity.PlatformApplicationLifecycleEvent;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRequirement;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRun;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRunLease;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRunTransitionEvent;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTaskTransitionEvent;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataAccessException;
import org.springframework.transaction.annotation.Transactional;

@SpringBootTest
@Transactional
class PlatformIntegrityIntegrationTest {

    @Autowired
    private AppMapper appMapper;

    @Autowired
    private PlatformRequirementMapper requirementMapper;

    @Autowired
    private PlatformTaskMapper taskMapper;

    @Autowired
    private PlatformRunMapper runMapper;

    @Autowired
    private PlatformApplicationLifecycleEventMapper lifecycleEventMapper;

    @Autowired
    private PlatformTaskTransitionEventMapper taskTransitionEventMapper;

    @Autowired
    private PlatformRunTransitionEventMapper runTransitionEventMapper;

    @Autowired
    private PlatformApplicationArchiveService archiveService;

    @Autowired
    private PlatformLogicalRelationValidator relationValidator;

    @Autowired
    private TaskExecutionBaselineFreezer baselineFreezer;

    @Autowired
    private PlatformTaskTransitionService taskTransitionService;

    @Autowired
    private PlatformRunTransitionService runTransitionService;

    @Autowired
    private PlatformRunLeaseService leaseService;

    @Autowired
    private PlatformValidationQueueMapper validationQueueMapper;

    @Autowired
    private PlatformValidationQueueEventMapper validationQueueEventMapper;

    @Test
    void archivesApplicationAndAppendsLifecycleEvidence() {
        Graph graph = createGraph();

        archiveService.archive(
            graph.application().getId(),
            graph.application().getUserId(),
            PlatformActor.OWNER,
            "OWNER_REQUEST",
            "archive-request"
        );

        assertEquals(
            "ARCHIVED",
            appMapper.selectOneByQuery(byId(graph.application().getId())).getLifecycleStatus()
        );
        assertEquals(1, lifecycleEventMapper.selectCountByQuery(
            QueryWrapper.create().eq("appId", graph.application().getId()).eq("eventType", "ARCHIVED")
        ));
    }

    @Test
    void rejectsArchiveWhileWritingRunIsActive() {
        Graph graph = createGraph();
        graph.run().setState(PlatformRunState.LEASED.name());
        runMapper.updateByQuery(
            graph.run(),
            true,
            com.mybatisflex.core.query.QueryWrapper.create().eq("id", graph.run().getId())
        );

        assertThrows(BusinessException.class, () -> archiveService.archive(
            graph.application().getId(),
            graph.application().getUserId(),
            PlatformActor.OWNER,
            "OWNER_REQUEST",
            "archive-active-run"
        ));
    }

    @Test
    void enforcesLogicalApplicationOwnership() {
        Graph graph = createGraph();
        App otherApplication = application(99L);
        appMapper.insertSelective(otherApplication);

        assertThrows(BusinessException.class, () -> relationValidator.requireRequirementBelongsToApplication(
            otherApplication.getId(),
            graph.requirement().getId()
        ));
    }

    /**
     * Lease 在 {@code CREATED→LEASED} 之前授予，该窗口内 Run 仍是 CREATED。
     * 只看 Run 状态的归档判据会放过这种「写入权已发出」的 Application。
     */
    @Test
    void rejectsArchiveWhileLeaseIsHeldOnStillCreatedRun() {
        Graph graph = createGraph();
        leaseService.grant(
            graph.run().getId(),
            PlatformActor.RUNTIME,
            "RUN_STARTED",
            "archive-lease-window"
        );

        assertEquals(
            PlatformRunState.CREATED.name(),
            runMapper.selectOneByQuery(byId(graph.run().getId())).getState()
        );
        assertThrows(BusinessException.class, () -> archiveService.archive(
            graph.application().getId(),
            graph.application().getUserId(),
            PlatformActor.OWNER,
            "OWNER_REQUEST",
            "archive-during-lease"
        ));
    }

    @Test
    void retainsRequirementAndFreezesTaskBaselineInDatabase() {
        Graph graph = createGraph();
        baselineFreezer.freeze(graph.task(), baseline());

        assertThrows(DataAccessException.class, () -> requirementMapper.deleteById(graph.requirement().getId()));
        PlatformTask changedTask = new PlatformTask();
        changedTask.setRequestedOutcome("changed");
        assertThrows(DataAccessException.class, () -> taskMapper.updateByQuery(
            changedTask,
            true,
            byId(graph.task().getId())
        ));
    }

    @Test
    void preventsAuditEventMutationAndDeletion() {
        Graph archiveGraph = createGraph();
        archiveService.archive(
            archiveGraph.application().getId(),
            archiveGraph.application().getUserId(),
            PlatformActor.OWNER,
            "OWNER_REQUEST",
            "append-only-archive"
        );
        PlatformApplicationLifecycleEvent lifecycleEvent = lifecycleEventMapper.selectOneByQuery(
            QueryWrapper.create().eq("appId", archiveGraph.application().getId())
        );
        PlatformApplicationLifecycleEvent lifecycleUpdate = new PlatformApplicationLifecycleEvent();
        lifecycleUpdate.setReasonCode("changed");
        assertThrows(DataAccessException.class, () -> lifecycleEventMapper.updateByQuery(
            lifecycleUpdate,
            true,
            byId(lifecycleEvent.getId())
        ));
        assertThrows(DataAccessException.class, () -> lifecycleEventMapper.deleteById(lifecycleEvent.getId()));

        Graph transitionGraph = createGraph();
        baselineFreezer.freeze(transitionGraph.task(), baseline());
        taskTransitionService.transition(
            transitionGraph.task().getId(),
            PlatformTaskState.CREATED,
            PlatformTaskState.READY,
            PlatformActor.PLATFORM,
            TaskTransitionConditions.none(),
            "BASELINE_FROZEN",
            null,
            "append-only-task"
        );
        leaseService.grant(
            transitionGraph.run().getId(),
            PlatformActor.RUNTIME,
            "RUN_STARTED",
            "append-only-lease"
        );
        runTransitionService.transition(
            transitionGraph.run().getId(),
            PlatformRunState.CREATED,
            PlatformRunState.LEASED,
            PlatformActor.PLATFORM,
            "LEASE_GRANTED",
            "lease-1",
            "append-only-run"
        );

        PlatformTaskTransitionEvent taskEvent = taskTransitionEventMapper.selectOneByQuery(
            QueryWrapper.create().eq("taskId", transitionGraph.task().getId())
        );
        PlatformTaskTransitionEvent taskUpdate = new PlatformTaskTransitionEvent();
        taskUpdate.setReasonCode("changed");
        assertThrows(DataAccessException.class, () -> taskTransitionEventMapper.updateByQuery(
            taskUpdate,
            true,
            byId(taskEvent.getId())
        ));
        assertThrows(DataAccessException.class, () -> taskTransitionEventMapper.deleteById(taskEvent.getId()));

        PlatformRunTransitionEvent runEvent = runTransitionEventMapper.selectOneByQuery(
            QueryWrapper.create().eq("runId", transitionGraph.run().getId())
        );
        PlatformRunTransitionEvent runUpdate = new PlatformRunTransitionEvent();
        runUpdate.setReasonCode("changed");
        assertThrows(DataAccessException.class, () -> runTransitionEventMapper.updateByQuery(
            runUpdate,
            true,
            byId(runEvent.getId())
        ));
        assertThrows(DataAccessException.class, () -> runTransitionEventMapper.deleteById(runEvent.getId()));
    }

    @Test
    void persistsTaskAndRunTransitionsWithAuditEvents() {
        Graph graph = createGraph();
        baselineFreezer.freeze(graph.task(), baseline());

        taskTransitionService.transition(
            graph.task().getId(),
            PlatformTaskState.CREATED,
            PlatformTaskState.READY,
            PlatformActor.PLATFORM,
            TaskTransitionConditions.none(),
            "BASELINE_FROZEN",
            null,
            "task-ready"
        );
        leaseService.grant(
            graph.run().getId(),
            PlatformActor.RUNTIME,
            "RUN_STARTED",
            "run-leased-lease"
        );
        runTransitionService.transition(
            graph.run().getId(),
            PlatformRunState.CREATED,
            PlatformRunState.LEASED,
            PlatformActor.PLATFORM,
            "LEASE_GRANTED",
            "lease-1",
            "run-leased"
        );

        assertEquals("READY", taskMapper.selectOneByQuery(byId(graph.task().getId())).getState());
        assertEquals("LEASED", runMapper.selectOneByQuery(byId(graph.run().getId())).getState());
        assertEquals(1, taskTransitionEventMapper.selectCountByQuery(
            QueryWrapper.create().eq("taskId", graph.task().getId())
        ));
        assertEquals(1, runTransitionEventMapper.selectCountByQuery(
            QueryWrapper.create().eq("runId", graph.run().getId())
        ));
    }

    @Test
    void enqueuesValidationWhenPlatformSucceedsTheRun() {
        Graph graph = createGraph();
        baselineFreezer.freeze(graph.task(), baseline());

        PlatformRunLease leaseEnqueue = leaseService.grant(
            graph.run().getId(), PlatformActor.RUNTIME, "RUN_STARTED", "lease-enqueue");
        runTransitionService.transition(graph.run().getId(), PlatformRunState.CREATED,
            PlatformRunState.LEASED, PlatformActor.PLATFORM, "LEASE_GRANTED", null, "run-enqueue-leased");
        runTransitionService.transition(graph.run().getId(), PlatformRunState.LEASED,
            PlatformRunState.EXECUTING, PlatformActor.PLATFORM, "RUN_EXECUTING", null, "run-enqueue-executing");

        // 失败终态不进入验证队列
        assertEquals(0, validationQueueMapper.selectCountByQuery(
            QueryWrapper.create().eq("runId", graph.run().getId())), "尚未成功前不得入队");
        leaseService.release(graph.run().getId(), leaseEnqueue.getFenceToken(),
            PlatformActor.RUNTIME, "RUN_FAILED", "lease-enqueue-2");
        runTransitionService.transition(graph.run().getId(), PlatformRunState.EXECUTING,
            PlatformRunState.FAILED, PlatformActor.PLATFORM, "RUN_FAILED", null, "run-enqueue-failed");
        assertEquals(0, validationQueueMapper.selectCountByQuery(
            QueryWrapper.create().eq("runId", graph.run().getId())), "失败终态不进入权威验证队列");
    }

    @Test
    void queuesValidationRequestOnTheSameTransactionAsTheSuccessfulRun() {
        Graph graph = createGraph();
        baselineFreezer.freeze(graph.task(), baseline());

        PlatformRunLease leaseQueue = leaseService.grant(
            graph.run().getId(), PlatformActor.RUNTIME, "RUN_STARTED", "lease-queue");
        runTransitionService.transition(graph.run().getId(), PlatformRunState.CREATED,
            PlatformRunState.LEASED, PlatformActor.PLATFORM, "LEASE_GRANTED", null, "run-queue-leased");
        runTransitionService.transition(graph.run().getId(), PlatformRunState.LEASED,
            PlatformRunState.EXECUTING, PlatformActor.PLATFORM, "RUN_EXECUTING", null, "run-queue-executing");
        leaseService.release(graph.run().getId(), leaseQueue.getFenceToken(),
            PlatformActor.RUNTIME, "RUN_DONE", "lease-queue-2");
        runTransitionService.transition(graph.run().getId(), PlatformRunState.EXECUTING,
            PlatformRunState.SUCCEEDED, PlatformActor.PLATFORM, "RUN_SUCCEEDED", null, "run-queue-succeeded");

        // 本项目的 @Transactional 由 MyBatis-Flex 事务管理器驱动，断言必须走同一条数据访问路径
        assertEquals(1, validationQueueMapper.selectCountByQuery(
            QueryWrapper.create().eq("runId", graph.run().getId())),
            "成功的 Run 必须由 Platform 显式登记验证队列");
        assertEquals(1, validationQueueMapper.selectCountByQuery(
            QueryWrapper.create().eq("runId", graph.run().getId()).eq("state", "PENDING")));
        assertEquals(3, runTransitionEventMapper.selectCountByQuery(
            QueryWrapper.create().eq("runId", graph.run().getId())), "本用例共三次 Run 转换");
        assertEquals(1, validationQueueEventMapper.selectCountByQuery(
            QueryWrapper.create().eq("runId", graph.run().getId())),
            "队列登记必须同时写入审计事件");
    }

    private Graph createGraph() {
        App application = application(1L);
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
        assertNotNull(task.getId());

        PlatformRun run = new PlatformRun();
        run.setId("run-" + task.getId());
        run.setApplicationId(application.getId());
        run.setTaskId(task.getId());
        run.setState(PlatformRunState.CREATED.name());
        run.setAttemptNumber(1);
        runMapper.insertSelective(run);
        return new Graph(application, requirement, task, run);
    }

    private App application(long ownerId) {
        App application = new App();
        application.setUserId(ownerId);
        application.setAppName("synthetic platform application");
        application.setCodeGenType("html");
        application.setIsDelete(0);
        application.setLifecycleStatus("ACTIVE");
        return application;
    }

    private TaskExecutionBaseline baseline() {
        return new TaskExecutionBaseline(1, null, null, "synthetic outcome", "synthetic acceptance");
    }

    private QueryWrapper byId(Object id) {
        return QueryWrapper.create().eq("id", id);
    }

    private record Graph(
        App application,
        PlatformRequirement requirement,
        PlatformTask task,
        PlatformRun run
    ) {}
}
