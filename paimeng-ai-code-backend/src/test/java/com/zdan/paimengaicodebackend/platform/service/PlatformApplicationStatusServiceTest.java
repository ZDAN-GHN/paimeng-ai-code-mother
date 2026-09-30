package com.zdan.paimengaicodebackend.platform.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformDeploymentMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.model.entity.User;
import com.zdan.paimengaicodebackend.platform.deployment.PlatformDeploymentReasonCode;
import com.zdan.paimengaicodebackend.platform.deployment.PlatformDeploymentStage;
import com.zdan.paimengaicodebackend.platform.deployment.PlatformDeploymentState;
import com.zdan.paimengaicodebackend.platform.deployment.PublicApplicationRouteResolver;
import com.zdan.paimengaicodebackend.platform.domain.PlatformActor;
import com.zdan.paimengaicodebackend.platform.domain.PlatformApplicationAccessGuard;
import com.zdan.paimengaicodebackend.platform.domain.PlatformOwnerVisibleStatus;
import com.zdan.paimengaicodebackend.platform.domain.PlatformProgressStage;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRequirementNormalizationService;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunProgressService;
import com.zdan.paimengaicodebackend.platform.domain.PlatformStatusChangeNotifier;
import com.zdan.paimengaicodebackend.platform.domain.PlatformTaskRetryService;
import com.zdan.paimengaicodebackend.platform.domain.PlatformTaskState;
import com.zdan.paimengaicodebackend.platform.entity.PlatformDeployment;
import com.zdan.paimengaicodebackend.platform.entity.PlatformNormalizationQueue;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRun;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRunProgressEvent;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import com.zdan.paimengaicodebackend.platform.vo.PlatformApplicationStatusVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformClarificationAnswerVO;
import java.time.LocalDateTime;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * 状态投影的两条不可退让的约束：
 * <ol>
 *   <li>每个 Owner 可见状态都必须能从 Platform 权威事实推出，不能靠猜；</li>
 *   <li>投影里不得出现 Pi Session、工具细节、Sandbox 标识或内部标识——这是 Product Layer
 *       与 Platform 内部证据链的边界。</li>
 * </ol>
 */
class PlatformApplicationStatusServiceTest {

    private static final long APPLICATION_ID = 460017668615995392L;
    private static final long TASK_ID = 460017668615995394L;
    private static final long REQUIREMENT_ID = 460017668615995393L;
    private static final long OWNER_ID = 377708067863715840L;

    private final PlatformApplicationAccessGuard accessGuard = mock(PlatformApplicationAccessGuard.class);
    private final PlatformTaskMapper taskMapper = mock(PlatformTaskMapper.class);
    private final PlatformRunMapper runMapper = mock(PlatformRunMapper.class);
    private final PlatformRequirementNormalizationService normalizationService =
        mock(PlatformRequirementNormalizationService.class);
    private final PlatformRunProgressService progressService = mock(PlatformRunProgressService.class);
    private final PlatformTaskRetryService retryService = mock(PlatformTaskRetryService.class);
    private final PlatformStatusChangeNotifier notifier = mock(PlatformStatusChangeNotifier.class);
    private final PlatformDeploymentMapper deploymentMapper = mock(PlatformDeploymentMapper.class);
    private final PublicApplicationRouteResolver routeResolver = mock(PublicApplicationRouteResolver.class);

    private PlatformApplicationStatusService statusService;

    @BeforeEach
    void setUp() {
        statusService = new PlatformApplicationStatusService(accessGuard, taskMapper, runMapper,
            normalizationService, progressService, retryService, notifier, deploymentMapper, routeResolver);
        lenient().when(routeResolver.publicBasePath()).thenReturn("/apps");
        lenient().when(deploymentMapper.selectHealthyForApplication(APPLICATION_ID)).thenReturn(null);
        lenient().when(deploymentMapper.selectLatestForApplication(APPLICATION_ID)).thenReturn(null);
        // 默认放行 ACTIVE Application；归档后必须拒绝写，这个边界在下面单独覆盖。
        lenient().when(accessGuard.requireManaged(eq(APPLICATION_ID), any(User.class)))
            .thenReturn(application("ACTIVE"));
        lenient().when(accessGuard.requireReadable(eq(APPLICATION_ID), any(User.class)))
            .thenReturn(application("ACTIVE"));
        lenient().when(accessGuard.actorFor(any(User.class))).thenReturn(PlatformActor.OWNER);
    }

    @Test
    void applicationWithoutAnyRequirementAsksOwnerToDescribeIt() {
        when(taskMapper.selectLatestForApplication(APPLICATION_ID)).thenReturn(null);

        PlatformApplicationStatusVO status = read();

        assertEquals(PlatformOwnerVisibleStatus.AWAITING_NORMALIZATION, status.getStatus());
        assertNull(status.getTaskId());
        assertFalse(status.isAnswerRequired());
    }

    @Test
    void queuedOrRunningNormalizationBothProjectToAwaitingNormalization() {
        whenTask("CREATED", null);
        whenQueue("PENDING");

        assertEquals(PlatformOwnerVisibleStatus.AWAITING_NORMALIZATION, read().getStatus());

        whenQueue("RUNNING");

        assertEquals(PlatformOwnerVisibleStatus.AWAITING_NORMALIZATION, read().getStatus());
    }

    @Test
    void normalizationInfrastructureFailureIsReportedAsFailedNotAsStillWaiting() {
        whenTask("CREATED", null);
        whenQueue("FAILED");

        PlatformApplicationStatusVO status = read();

        assertEquals(PlatformOwnerVisibleStatus.FAILED, status.getStatus());
        assertEquals("整理需求时出现异常，请重新提交一次需求。", status.getFailureReason());
    }

    @Test
    void readyTaskProjectsReady() {
        whenTask("READY", null);

        assertEquals(PlatformOwnerVisibleStatus.READY, read().getStatus());
    }

    @Test
    void executingTaskProjectsExecuting() {
        whenTask("EXECUTING", null);
        when(runMapper.selectLatestForTask(TASK_ID)).thenReturn(run("run-1", "EXECUTING"));

        PlatformApplicationStatusVO status = read();

        assertEquals(PlatformOwnerVisibleStatus.EXECUTING, status.getStatus());
        assertEquals("run-1", status.getRunId());
    }

    @Test
    void blockedTaskExposesExactlyOneQuestionAndAcceptsAnAnswer() {
        whenTask("BLOCKED", "客户可以提前几天预约？");
        var outcome = new PlatformRequirementNormalizationService.ClarificationOutcome(701L, TASK_ID, true);
        when(normalizationService.answerBlockingQuestion(
            eq(APPLICATION_ID), eq(TASK_ID), eq("提前 14 天"), eq(PlatformActor.OWNER), any(String.class)))
            .thenReturn(outcome);

        PlatformApplicationStatusVO blocked = read();
        assertEquals(PlatformOwnerVisibleStatus.BLOCKED, blocked.getStatus());
        assertTrue(blocked.isAnswerRequired());
        assertEquals("客户可以提前几天预约？", blocked.getBlockingQuestion());

        PlatformClarificationAnswerVO accepted = statusService.answerBlockingQuestion(
            APPLICATION_ID, String.valueOf(TASK_ID), "提前 14 天", owner());

        assertEquals("701", accepted.getAnswerRequirementId());
        assertEquals(String.valueOf(TASK_ID), accepted.getTaskId());
        assertTrue(accepted.isReopenedSameTask());
    }

    @Test
    void nonBlockedTaskHasNoQuestionEvenIfAQuestionWasRecorded() {
        whenTask("EXECUTING", "过期的问题");

        PlatformApplicationStatusVO status = read();

        assertFalse(status.isAnswerRequired());
        assertNull(status.getBlockingQuestion());
    }

    @Test
    void failedTaskExplainsInOwnerLanguageWithoutLeakingInternalCodes() {
        whenFailedTaskWith("VALIDATION_FAILED");

        PlatformApplicationStatusVO status = read();

        assertEquals(PlatformOwnerVisibleStatus.FAILED, status.getStatus());
        assertEquals("验证没有通过，可以查看要求后重新提交需求。", status.getFailureReason());

        // 未登记的内部原因码一律不展示，而不是原样透给 Owner。
        whenFailedTaskWith("SOME_INTERNAL_GATE_CODE");

        assertNull(read().getFailureReason());
    }

    @Test
    void validatedTaskProjectsValidationSuccess() {
        whenTask("VALIDATED", null);

        assertEquals(PlatformOwnerVisibleStatus.VALIDATED, read().getStatus());
    }

    @Test
    void progressStageIsProjectedButUnknownStageDegradesInsteadOfFailing() {
        whenTask("EXECUTING", null);
        progress("NORMALIZING");
        assertEquals(PlatformProgressStage.NORMALIZING, read().getProgressStage());

        progress("SOMETHING_ELSE");
        assertNull(read().getProgressStage());
    }

    @Test
    void projectionNeverCarriesInternalExecutionDetail() {
        whenTask("EXECUTING", null);
        when(runMapper.selectLatestForTask(TASK_ID)).thenReturn(run("run-internal", "EXECUTING"));
        progress("EXECUTING");

        PlatformApplicationStatusVO status = read();

        // runId 是 Platform 内部标识，前端不展示；契约保留它只是为了可追溯查询。
        assertEquals("run-internal", status.getRunId());
        for (String forbidden : new String[] {"pi", "session", "tool", "sandbox", "container", "commit"}) {
            assertFalse(containsIgnoreCase(status.getHeadline(), forbidden), "headline leaked " + forbidden);
            assertFalse(containsIgnoreCase(status.getDetail(), forbidden), "detail leaked " + forbidden);
            assertFalse(containsIgnoreCase(String.valueOf(status.getProgressStage()), forbidden), "stage leaked " + forbidden);
        }
    }

    @Test
    void archivedApplicationStaysReadableButRefusesAnswers() {
        when(accessGuard.requireManaged(eq(APPLICATION_ID), any(User.class)))
            .thenThrow(new BusinessException(ErrorCode.NOT_FOUND_ERROR, "Application 不存在或已归档"));

        assertThrows(BusinessException.class, () -> statusService.answerBlockingQuestion(
            APPLICATION_ID, String.valueOf(TASK_ID), "提前 14 天", owner()));
        verify(normalizationService, never())
            .answerBlockingQuestion(anyLong(), anyLong(), anyString(), any(), anyString());
    }

    @Test
    void malformedIdentifiersAndEmptyAnswersAreRejectedBeforeTheDomainIsTouched() {

        assertThrows(BusinessException.class, () -> statusService.answerBlockingQuestion(
            APPLICATION_ID, "0", "answer", owner()));
        assertThrows(BusinessException.class, () -> statusService.answerBlockingQuestion(
            APPLICATION_ID, "not-a-number", "answer", owner()));
        assertThrows(BusinessException.class, () -> statusService.answerBlockingQuestion(
            APPLICATION_ID, String.valueOf(TASK_ID), "   ", owner()));
        assertThrows(BusinessException.class, () -> statusService.answerBlockingQuestion(
            APPLICATION_ID, String.valueOf(TASK_ID), "x".repeat(4001), owner()));
    }

    @Test
    void releasedTaskWithoutHealthyDeploymentIsShownAsNotLiveWithControlledDiagnosis() {
        whenTask("RELEASED", null);
        when(deploymentMapper.selectLatestForApplication(APPLICATION_ID)).thenReturn(
            deployment(PlatformDeploymentState.UNHEALTHY, PlatformDeploymentReasonCode.HEALTH_PROBE_FAILED));

        PlatformApplicationStatusVO status = read();

        assertFalse(status.isLive());
        assertNull(status.getPublicUrl());
        assertEquals(PlatformDeploymentStage.UNHEALTHY.name(), status.getDeployStage());
        assertEquals(PlatformDeploymentReasonCode.HEALTH_PROBE_FAILED.name(), status.getDeployReason());
        // 「已发布固定版本」会误导 Owner：Task released 只说明固定版本已创建。
        assertEquals(PlatformDeploymentStage.UNHEALTHY.ownerText(), status.getHeadline());
        assertTrue(containsIgnoreCase(status.getDetail(), "暂未对外开放"));
        // 受控诊断不含容器、版本、日志或基础设施细节。
        assertFalse(containsIgnoreCase(status.getDetail(), "container"));
        assertFalse(containsIgnoreCase(status.getDetail(), "172."));
    }

    @Test
    void releasedTaskWhileDeployingIsNotYetDescribedAsLive() {
        whenTask("RELEASED", null);
        when(deploymentMapper.selectLatestForApplication(APPLICATION_ID)).thenReturn(
            deployment(PlatformDeploymentState.PROVISIONING, null));

        PlatformApplicationStatusVO status = read();

        assertFalse(status.isLive());
        assertEquals(PlatformDeploymentStage.PROVISIONING.name(), status.getDeployStage());
        assertNull(status.getDeployReason());
        assertTrue(containsIgnoreCase(status.getHeadline(), "正在准备上线"));
    }

    @Test
    void healthyDeploymentPublishesTheStableApplicationScopedUrl() {
        whenTask("RELEASED", null);
        PlatformDeployment healthy = deployment(PlatformDeploymentState.HEALTHY, null);
        healthy.setContainerAddress("172.18.0.9");
        when(deploymentMapper.selectHealthyForApplication(APPLICATION_ID)).thenReturn(healthy);

        PlatformApplicationStatusVO status = read();

        assertTrue(status.isLive());
        assertEquals("/apps/" + APPLICATION_ID + "/", status.getPublicUrl());
        assertEquals(PlatformDeploymentStage.HEALTHY.name(), status.getDeployStage());
    }

    @Test
    void unregisteredReasonCodeIsNotProjected() {
        whenTask("RELEASED", null);
        PlatformDeployment tampered = deployment(PlatformDeploymentState.UNHEALTHY, null);
        tampered.setReasonCode("DATABASE_URL=postgres://user:secret@db/internal failed");
        when(deploymentMapper.selectLatestForApplication(APPLICATION_ID)).thenReturn(tampered);

        PlatformApplicationStatusVO status = read();

        assertNull(status.getDeployReason());
        assertFalse(containsIgnoreCase(status.getDetail(), "secret"));
    }

    private PlatformDeployment deployment(PlatformDeploymentState state, PlatformDeploymentReasonCode reason) {
        PlatformDeployment deployment = new PlatformDeployment();
        deployment.setId(7L);
        deployment.setApplicationId(APPLICATION_ID);
        deployment.setState(state.name());
        deployment.setStage(state == PlatformDeploymentState.HEALTHY
            ? PlatformDeploymentStage.HEALTHY.name()
            : (state == PlatformDeploymentState.UNHEALTHY
                ? PlatformDeploymentStage.UNHEALTHY.name()
                : PlatformDeploymentStage.PROVISIONING.name()));
        deployment.setReasonCode(reason == null ? null : reason.name());
        return deployment;
    }

    private PlatformApplicationStatusVO read() {
        return statusService.getStatus(APPLICATION_ID, owner());
    }

    private void whenTask(String state, String question) {
        when(taskMapper.selectLatestForApplication(APPLICATION_ID)).thenReturn(task(state, question));
    }

    private void whenFailedTaskWith(String failureCode) {
        PlatformTask task = task("FAILED", null);
        task.setFailureCode(failureCode);
        when(taskMapper.selectLatestForApplication(APPLICATION_ID)).thenReturn(task);
    }

    private void whenQueue(String queueState) {
        PlatformNormalizationQueue queue = new PlatformNormalizationQueue();
        queue.setState(queueState);
        queue.setTaskId(TASK_ID);
        when(normalizationService.latestQueueForTask(TASK_ID)).thenReturn(queue);
    }

    private void progress(String stage) {
        PlatformRunProgressEvent event = new PlatformRunProgressEvent();
        event.setStage(stage);
        event.setTaskId(TASK_ID);
        when(progressService.latest(APPLICATION_ID, TASK_ID)).thenReturn(event);
    }

    private PlatformTask task(String state, String question) {
        PlatformTask task = new PlatformTask();
        task.setId(TASK_ID);
        task.setApplicationId(APPLICATION_ID);
        task.setRequirementId(REQUIREMENT_ID);
        task.setState(state);
        task.setBlockedQuestion(question);
        task.setUpdatedAt(LocalDateTime.now());
        return task;
    }

    private PlatformRun run(String runId, String state) {
        PlatformRun run = new PlatformRun();
        run.setId(runId);
        run.setApplicationId(APPLICATION_ID);
        run.setTaskId(TASK_ID);
        run.setState(state);
        return run;
    }

    private App application(String lifecycleStatus) {
        App application = new App();
        application.setId(APPLICATION_ID);
        application.setUserId(OWNER_ID);
        application.setLifecycleStatus(lifecycleStatus);
        return application;
    }

    private User owner() {
        User user = new User();
        user.setId(OWNER_ID);
        user.setUserRole("user");
        return user;
    }

    private boolean containsIgnoreCase(String value, String needle) {
        return value != null && value.toLowerCase().contains(needle);
    }
}
