package com.zdan.paimengaicodebackend.platform.domain;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformApplicationLifecycleEventMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformApplicationMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRequirementMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunTransitionEventMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskTransitionEventMapper;
import com.zdan.paimengaicodebackend.platform.entity.PlatformApplication;
import com.zdan.paimengaicodebackend.platform.entity.PlatformApplicationLifecycleEvent;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRequirement;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRun;
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
    private PlatformApplicationMapper applicationMapper;

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

    @Test
    void archivesApplicationAndAppendsLifecycleEvidence() {
        Graph graph = createGraph();

        archiveService.archive(
            graph.application().getId(),
            graph.application().getOwnerId(),
            PlatformActor.OWNER,
            "OWNER_REQUEST",
            "archive-request"
        );

        assertNull(applicationMapper.selectOneByQuery(byId(graph.application().getId())));
        assertEquals(1, lifecycleEventMapper.selectCountByQuery(
            QueryWrapper.create().eq("application_id", graph.application().getId()).eq("event_type", "ARCHIVED")
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
            graph.application().getOwnerId(),
            PlatformActor.OWNER,
            "OWNER_REQUEST",
            "archive-active-run"
        ));
    }

    @Test
    void enforcesLogicalApplicationOwnership() {
        Graph graph = createGraph();
        PlatformApplication otherApplication = application(99L);
        applicationMapper.insertSelective(otherApplication);

        assertThrows(BusinessException.class, () -> relationValidator.requireRequirementBelongsToApplication(
            otherApplication.getId(),
            graph.requirement().getId()
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
            archiveGraph.application().getOwnerId(),
            PlatformActor.OWNER,
            "OWNER_REQUEST",
            "append-only-archive"
        );
        PlatformApplicationLifecycleEvent lifecycleEvent = lifecycleEventMapper.selectOneByQuery(
            QueryWrapper.create().eq("application_id", archiveGraph.application().getId())
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
            QueryWrapper.create().eq("task_id", transitionGraph.task().getId())
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
            QueryWrapper.create().eq("run_id", transitionGraph.run().getId())
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
            QueryWrapper.create().eq("task_id", graph.task().getId())
        ));
        assertEquals(1, runTransitionEventMapper.selectCountByQuery(
            QueryWrapper.create().eq("run_id", graph.run().getId())
        ));
    }

    private Graph createGraph() {
        PlatformApplication application = application(1L);
        applicationMapper.insertSelective(application);

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

    private PlatformApplication application(long ownerId) {
        PlatformApplication application = new PlatformApplication();
        application.setOwnerId(ownerId);
        application.setName("synthetic platform application");
        application.setIsDeleted(0);
        return application;
    }

    private TaskExecutionBaseline baseline() {
        return new TaskExecutionBaseline(1, null, null, "synthetic outcome", "synthetic acceptance");
    }

    private QueryWrapper byId(Object id) {
        return QueryWrapper.create().eq("id", id);
    }

    private record Graph(
        PlatformApplication application,
        PlatformRequirement requirement,
        PlatformTask task,
        PlatformRun run
    ) {}
}
