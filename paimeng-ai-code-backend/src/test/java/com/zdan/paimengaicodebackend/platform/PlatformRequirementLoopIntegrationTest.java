package com.zdan.paimengaicodebackend.platform;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRequirementMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.model.entity.User;
import com.zdan.paimengaicodebackend.platform.domain.PlatformActor;
import com.zdan.paimengaicodebackend.platform.domain.PlatformOwnerVisibleStatus;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRequirementNormalizationService;
import com.zdan.paimengaicodebackend.platform.dto.PlatformNormalizationResultRequest;
import com.zdan.paimengaicodebackend.platform.dto.PlatformRunProgressRequest;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRequirement;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRun;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import com.zdan.paimengaicodebackend.platform.service.PlatformAgentWorkService;
import com.zdan.paimengaicodebackend.platform.service.PlatformApplicationManagementService;
import com.zdan.paimengaicodebackend.platform.service.PlatformApplicationStatusService;
import com.zdan.paimengaicodebackend.platform.vo.PlatformApplicationStatusVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformClarificationAnswerVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformRequirementVO;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.transaction.annotation.Transactional;

/**
 * Requirement 到受控 Run 的闭环集成测试（Issue #80 / T-08）
 *
 * <p>在真实 MySQL 上走完 Owner 提交 → Platform 排队 → Agent 归一化 → Task 就绪 → Run 可领取 →
 * 阻断 → Owner 答复 → 重新归一化。每一步都走 Agent 实际使用的服务入口，因此契约漂移会在这里
 * 暴露，而不是等到联调。
 *
 * <p>刻意不引入 Docker：这里验证的是「归一化结论与 Owner 状态如何改变 Task 状态」，门禁执行
 * 本身是 #79 的职责，由 {@code CandidateValidationGateRunner} 单独覆盖。
 */
@SpringBootTest
@Transactional
class PlatformRequirementLoopIntegrationTest {

    private static final long OWNER_ID = 377708067863715840L;
    private static final long STRANGER_ID = 424242424242424242L;

    @Autowired
    private PlatformRequirementMapper requirementMapper;
    @Autowired
    private PlatformTaskMapper taskMapper;
    @Autowired
    private PlatformRunMapper runMapper;
    @Autowired
    private PlatformApplicationManagementService managementService;
    @Autowired
    private PlatformApplicationStatusService statusService;
    @Autowired
    private PlatformAgentWorkService workService;

    @Test
    void requirementWaitsForNormalizationAndCreatesNoRun() {
        ApplicationFixture fixture = newApplication();

        PlatformRequirementVO submitted = fixture.submit("我想要一个预约管理的小程序");

        assertEquals("PENDING_NORMALIZATION", submitted.getNormalizationStatus());
        assertEquals("OWNER_REQUEST", submitted.getKind());
        PlatformApplicationStatusVO status = fixture.status();
        assertEquals(PlatformOwnerVisibleStatus.AWAITING_NORMALIZATION, status.getStatus());
        assertFalse(status.isAnswerRequired());
        assertNull(status.getRunId());
        assertTrue(countRuns(fixture) == 0, "等待归一化时不得存在 Run");
    }

    @Test
    void clearRequirementFreezesBaselineAndCreatesAQueryableRun() {
        ApplicationFixture fixture = newApplication();
        fixture.submit("我想要一个预约管理的小程序");

        var claim = fixture.claimNormalization();
        fixture.report(ready(claim, "Create an appointment intake workflow",
            "An owner can submit an appointment request and view its status"));

        PlatformApplicationStatusVO status = fixture.status();
        assertEquals(PlatformOwnerVisibleStatus.READY, status.getStatus());
        assertNotNull(status.getRunId());
        assertNull(status.getBlockingQuestion());

        PlatformTask task = fixture.latestTask();
        assertEquals("READY", task.getState());
        assertNotNull(task.getBaselineJson());
        // 基线事实来自 Platform 而非 Agent：首版 Application 还没有稳定来源版本。
        assertNull(task.getBaseSourceRevision());
        assertNull(task.getBaseProfileVersion());
        assertEquals("Create an appointment intake workflow", task.getRequestedOutcome());
        assertNull(task.getBlockedQuestion());

        var runItem = workService.claimRun().orElseThrow(() -> new AssertionError("ready Task 必须可被领取"));
        PlatformRun run = runMapper.selectOneById(runItem.getRunId());
        assertEquals("CREATED", run.getState());
        assertEquals("READY", taskMapper.selectOneById(run.getTaskId()).getState());
    }

    @Test
    void ownerSeesExactlyOneBlockingQuestionAndNoSandboxWriteIsPossible() {
        ApplicationFixture fixture = newApplication();
        fixture.submit("我想要一个预约管理的小程序");

        var claim = fixture.claimNormalization();
        fixture.report(blocked(claim, "客户可以提前几天预约？"));

        PlatformApplicationStatusVO status = fixture.status();
        assertEquals(PlatformOwnerVisibleStatus.BLOCKED, status.getStatus());
        assertTrue(status.isAnswerRequired());
        assertEquals("客户可以提前几天预约？", status.getBlockingQuestion());

        // 答复前既没有 Run，也就没有 fenced Lease 可申请、更没有版本晋升。
        assertEquals(0, countRuns(fixture));
        assertNull(fixture.latestTask().getBaselineJson());
        assertTrue(workService.claimRun().isEmpty());
    }

    @Test
    void ownerAnswerReopensTheSameTaskAlongTheAllowedEdge() {
        ApplicationFixture fixture = newApplication();
        fixture.submit("我想要一个预约管理的小程序");
        var claim = fixture.claimNormalization();
        fixture.report(blocked(claim, "客户可以提前几天预约？"));
        long blockedTaskId = fixture.latestTask().getId();
        long originalRequirementId = fixture.latestTask().getRequirementId();

        PlatformClarificationAnswerVO accepted = statusService.answerBlockingQuestion(
            fixture.applicationId, String.valueOf(blockedTaskId), "提前 14 天", owner());
        assertTrue(accepted.isReopenedSameTask());
        assertEquals(String.valueOf(blockedTaskId), accepted.getTaskId());

        PlatformRequirement answer = requirementMapper.selectOneById(Long.valueOf(accepted.getAnswerRequirementId()));
        assertEquals("CLARIFICATION_ANSWER", answer.getKind());
        assertEquals(originalRequirementId, answer.getParentRequirementId());
        assertEquals("提前 14 天", answer.getOriginalText());

        // blocked -> created 是同一条记录：基线仍未冻结，待答问题已清空。
        PlatformTask reopened = taskMapper.selectOneById(blockedTaskId);
        assertEquals("CREATED", reopened.getState());
        assertNull(reopened.getBaselineJson());
        assertNull(reopened.getBlockedQuestion());

        var secondClaim = fixture.claimNormalization();
        assertEquals(accepted.getAnswerRequirementId(), String.valueOf(secondClaim.requirementId()));
        fixture.report(ready(secondClaim, "支持 14 天内预约", "An owner can book an appointment up to 14 days ahead"));
        assertEquals(PlatformOwnerVisibleStatus.READY, fixture.status().getStatus());
    }

    @Test
    void onlyOwnerOrSystemAdministratorMayReadStatusOrSubmitAnAnswer() {
        ApplicationFixture fixture = newApplication();
        fixture.submit("我想要一个预约管理的小程序");
        var claim = fixture.claimNormalization();
        fixture.report(blocked(claim, "客户可以提前几天预约？"));
        long blockedTaskId = fixture.latestTask().getId();

        assertEquals(40101, assertThrows(BusinessException.class,
            () -> statusService.getStatus(fixture.applicationId, user(STRANGER_ID, "user"))).getCode());
        assertEquals(40101, assertThrows(BusinessException.class,
            () -> statusService.answerBlockingQuestion(
                fixture.applicationId, String.valueOf(blockedTaskId), "提前 14 天", user(STRANGER_ID, "user"))).getCode());
        // 越权请求不得产生任何领域副作用。
        assertEquals("BLOCKED", taskMapper.selectOneById(blockedTaskId).getState());
        assertEquals(1, countRequirements(fixture));

        assertNotNull(statusService.getStatus(fixture.applicationId, user(1L, "admin")));
    }

    @Test
    void runtimeProgressProjectsCoarseStageWithoutToolDetail() {
        ApplicationFixture fixture = newApplication();
        fixture.submit("我想要一个预约管理的小程序");
        var claim = fixture.claimNormalization();
        fixture.report(ready(claim, "outcome", "acceptance"));
        var runItem = workService.claimRun().orElseThrow();

        PlatformRunProgressRequest progress = new PlatformRunProgressRequest();
        progress.setApplicationId(String.valueOf(fixture.applicationId));
        progress.setRunId(runItem.getRunId());
        progress.setStage("EXECUTING");
        progress.setNote("bash ls -la /workspace && cat /etc/passwd");
        progress.setRequestId("progress-1");
        workService.reportProgress(progress);

        PlatformApplicationStatusVO status = fixture.status();
        assertEquals("EXECUTING", status.getProgressStage().name());
        // Owner 可见文案里不得出现命令或容器信息。
        assertFalse(status.getHeadline().toLowerCase().contains("sandbox"));
        assertFalse(status.getDetail().toLowerCase().contains("bash"));
    }

    @Test
    void resultWithoutAPlatformIssuedCredentialIsRejected() {
        ApplicationFixture fixture = newApplication();
        fixture.submit("我想要一个预约管理的小程序");
        fixture.claimNormalization();

        PlatformNormalizationResultRequest forged = ready(
            new PlatformRequirementNormalizationService.Claim(0L, fixture.applicationId,
                fixture.latestTask().getRequirementId(), fixture.latestTask().getId(),
                "00000000-0000-4000-8000-000000000000"),
            "outcome", "acceptance");

        assertEquals(40300, assertThrows(BusinessException.class,
            () -> workService.reportNormalization(forged)).getCode());
        assertEquals("CREATED", fixture.latestTask().getState());
    }

    @Test
    void blockingOutcomeMustCarryExactlyOneNonBlankQuestion() {
        ApplicationFixture fixture = newApplication();
        fixture.submit("我想要一个预约管理的小程序");
        var claim = fixture.claimNormalization();

        assertEquals(40000, assertThrows(BusinessException.class,
            () -> workService.reportNormalization(blocked(claim, null))).getCode());
        assertEquals(40000, assertThrows(BusinessException.class,
            () -> workService.reportNormalization(blocked(claim, "   "))).getCode());
        // 被拒绝的结果不得推进状态。
        assertEquals("CREATED", fixture.latestTask().getState());
    }

    @Test
    void readyOutcomeCannotSmuggleABlockingQuestionAlongsideTheBaseline() {
        ApplicationFixture fixture = newApplication();
        fixture.submit("我想要一个预约管理的小程序");
        var claim = fixture.claimNormalization();
        PlatformNormalizationResultRequest request = ready(claim, "outcome", "acceptance");
        request.setBlockingQuestion("顺便问一下，要不要加登录？");

        assertEquals(40000, assertThrows(BusinessException.class,
            () -> workService.reportNormalization(request)).getCode());
        assertEquals("CREATED", fixture.latestTask().getState());
    }

    @Test
    void ownerCannotAnswerATaskThatIsNotBlocked() {
        ApplicationFixture fixture = newApplication();
        fixture.submit("我想要一个预约管理的小程序");
        var claim = fixture.claimNormalization();
        fixture.report(ready(claim, "outcome", "acceptance"));

        assertEquals(40300, assertThrows(BusinessException.class,
            () -> statusService.answerBlockingQuestion(
                fixture.applicationId, String.valueOf(fixture.latestTask().getId()), "提前 14 天", owner())).getCode());
    }

    private PlatformNormalizationResultRequest ready(
        PlatformRequirementNormalizationService.Claim claim,
        String requestedOutcome,
        String acceptanceTarget
    ) {
        PlatformNormalizationResultRequest request = base(claim);
        request.setOutcome(PlatformNormalizationResultRequest.OUTCOME_READY);
        request.setRequestedOutcome(requestedOutcome);
        request.setAcceptanceTarget(acceptanceTarget);
        return request;
    }

    private PlatformNormalizationResultRequest blocked(
        PlatformRequirementNormalizationService.Claim claim,
        String blockingQuestion
    ) {
        PlatformNormalizationResultRequest request = base(claim);
        request.setOutcome(PlatformNormalizationResultRequest.OUTCOME_BLOCKED);
        request.setBlockingQuestion(blockingQuestion);
        return request;
    }

    private PlatformNormalizationResultRequest base(PlatformRequirementNormalizationService.Claim claim) {
        PlatformNormalizationResultRequest request = new PlatformNormalizationResultRequest();
        request.setApplicationId(String.valueOf(claim.applicationId()));
        request.setTaskId(String.valueOf(claim.taskId()));
        request.setAttemptId(claim.attemptId());
        request.setRequestId("normalize-" + claim.attemptId());
        return request;
    }

    private int countRuns(ApplicationFixture fixture) {
        return runMapper.selectListByQuery(QueryWrapper.create().eq("appId", fixture.applicationId)).size();
    }

    private int countRequirements(ApplicationFixture fixture) {
        return requirementMapper.selectListByQuery(QueryWrapper.create().eq("appId", fixture.applicationId)).size();
    }

    private ApplicationFixture newApplication() {
        return new ApplicationFixture(
            Long.valueOf(managementService.createApplication(user(OWNER_ID, "user"), "Product").getId()));
    }

    private User owner() {
        return user(OWNER_ID, "user");
    }

    private User user(long id, String role) {
        User user = new User();
        user.setId(id);
        user.setUserRole(role);
        return user;
    }

    /** 一个 Owner 拥有的 ACTIVE Application，以及围绕它的断言辅助。 */
    private final class ApplicationFixture {
        private final Long applicationId;

        private ApplicationFixture(Long applicationId) {
            this.applicationId = applicationId;
        }

        private PlatformRequirementVO submit(String text) {
            return managementService.submitRequirement(applicationId, owner(), text);
        }

        private PlatformApplicationStatusVO status() {
            return statusService.getStatus(applicationId, owner());
        }

        private PlatformTask latestTask() {
            return taskMapper.selectLatestForApplication(applicationId);
        }

        private PlatformRequirementNormalizationService.Claim claimNormalization() {
            var item = workService.claimNormalization()
                .orElseThrow(() -> new AssertionError("expected a pending normalization work item"));
            return new PlatformRequirementNormalizationService.Claim(0L,
                Long.valueOf(item.getApplicationId()),
                Long.valueOf(item.getRequirementId()),
                Long.valueOf(item.getTaskId()),
                item.getAttemptId());
        }

        private void report(PlatformNormalizationResultRequest request) {
            workService.reportNormalization(request);
        }
    }
}
