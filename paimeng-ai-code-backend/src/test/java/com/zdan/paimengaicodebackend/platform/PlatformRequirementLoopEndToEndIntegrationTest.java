package com.zdan.paimengaicodebackend.platform;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.when;

import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.mapper.AppMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRequirementMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.mapper.platform.SourceRevisionMapper;
import com.zdan.paimengaicodebackend.mapper.platform.ValidationEvidenceMapper;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.model.entity.User;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.platform.domain.PlatformActor;
import com.zdan.paimengaicodebackend.platform.domain.PlatformOwnerVisibleStatus;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRequirementNormalizationService;
import com.zdan.paimengaicodebackend.platform.dto.PlatformNormalizationResultRequest;
import com.zdan.paimengaicodebackend.platform.entity.CandidateSourceSnapshot;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import com.zdan.paimengaicodebackend.platform.entity.SourceRevision;
import com.zdan.paimengaicodebackend.platform.entity.ValidationEvidence;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxExecutor;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxHandle;
import com.zdan.paimengaicodebackend.platform.service.PlatformAgentWorkService;
import com.zdan.paimengaicodebackend.platform.service.PlatformApplicationManagementService;
import com.zdan.paimengaicodebackend.platform.service.PlatformApplicationStatusService;
import com.zdan.paimengaicodebackend.platform.service.PlatformRunExecutionService;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateGitStore;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateSnapshotService;
import com.zdan.paimengaicodebackend.platform.validation.CandidateFourGateExecutor;
import com.zdan.paimengaicodebackend.platform.validation.CandidateValidationGateRunner;
import com.zdan.paimengaicodebackend.platform.validation.PlatformValidationWorker;
import com.zdan.paimengaicodebackend.platform.vo.PlatformApplicationStatusVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformRunLeaseGrantVO;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.annotation.Transactional;

/**
 * Issue #80 验收：闭环的真实数据库证据（AC1、AC5）
 *
 * <p>只有两个 Docker 依赖的边界被打桩，其余全部走真实实现：
 * <ul>
 *   <li>{@code PlatformSandboxExecutor}——受控容器本身；桩只负责导出一份带
 *       {@code .platform/profile-disposition.json} 的归档，好让真实的 Snapshot 冻结、Git 提交、
 *       Profile 申报读取跑起来。</li>
 *   <li>{@code CandidateValidationGateRunner}——四类门禁的执行（需要 Docker 与隔离 MySQL，
 *       属于 #79 的范围）。</li>
 * </ul>
 *
 * <p>因此这条用例真实证明的是：归一化结果如何冻结基线并创建 Run、执行后如何形成可查询的
 * Snapshot、验证结论如何经由真实队列与证据链改变 Task 状态并（通过时）驱动唯一晋升路径。
 * 它不证明门禁本身会通过或失败——那由 {@code CandidateFourGateExecutor} 的测试负责。
 */
@SpringBootTest(properties = {"platform.sandbox.enabled=true", "platform.execution.enabled=true"})
@Transactional
class PlatformRequirementLoopEndToEndIntegrationTest {

    private static final Path SNAPSHOT_ROOT = snapshotRoot();
    private static final long OWNER_ID = 377708067863715840L;
    private static final String PROFILE_MANIFEST = ".platform/profile-disposition.json";

    @DynamicPropertySource
    static void snapshotProperties(DynamicPropertyRegistry properties) {
        properties.add("platform.snapshot.repo-root", SNAPSHOT_ROOT::toString);
    }

    @AfterAll
    static void removeTestGitRoot() throws IOException {
        try (var paths = Files.walk(SNAPSHOT_ROOT)) {
            for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(path);
            }
        }
    }

    @Autowired private AppMapper appMapper;
    @Autowired private PlatformRequirementMapper requirementMapper;
    @Autowired private PlatformTaskMapper taskMapper;
    @Autowired private PlatformRunMapper runMapper;
    @Autowired private SourceRevisionMapper revisionMapper;
    @Autowired private PlatformApplicationManagementService managementService;
    @Autowired private PlatformApplicationStatusService statusService;
    @Autowired private PlatformAgentWorkService workService;
    @Autowired private PlatformValidationWorker validationWorker;
    @Autowired private PlatformRunExecutionService executionService;
    @Autowired private CandidateSnapshotService snapshotService;
    @Autowired private ValidationEvidenceMapper evidenceMapper;
    @Autowired private com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskRetryRequestMapper retryRequestMapper;
    @Autowired private com.zdan.paimengaicodebackend.platform.domain.PlatformTaskRetryService retryService;

    @MockBean private PlatformSandboxExecutor sandboxExecutor;
    @MockBean private CandidateValidationGateRunner gateRunner;

    @BeforeEach
    void stubDockerBoundaries() throws IOException {
        when(sandboxExecutor.find(any())).thenReturn(Optional.empty());
        when(gateRunner.validate(any(), any())).thenReturn(passingReport());
    }

    @AfterEach
    void archiveApplication() {
        // appId 走应用内软删除而非物理删除：platform_* 表普遍禁止物理删除，测试也不该例外。
        appMapper.selectListByQuery(QueryWrapper.create())
            .stream()
            .map(App::getId)
            .filter(java.util.Objects::nonNull)
            .forEach(id -> {
                App archived = new App();
                archived.setId(id);
                archived.setIsDelete(1);
                appMapper.update(archived);
            });
    }

    /**
     * AC5 的 `ready` → `executing` → Validation 成功路径。
     *
     * <p>断言的不只是状态：还要有可查询的 Run、真实 Git 里的 Snapshot、四条绑定同一 Platform
     * 尝试的 PASS Evidence，以及唯一的 SourceRevision 晋升。
     */
    @Test
    void verifiedCandidatePromotesExactlyOneSourceRevisionAndValidatesTheTask() {
        Loop loop = runToSucceeded("我想要一个预约管理的小程序", "支持 14 天内预约", "可以提前 14 天预约");

        assertEquals(PlatformOwnerVisibleStatus.EXECUTING, statusService.getStatus(loop.applicationId(), owner()).getStatus());
        assertNotNull(loop.snapshot().getCommitHash());
        assertNotNull(loop.snapshot().getTreeHash());
        assertEquals(64, loop.snapshot().getBaselineHash().length());

        Optional<PlatformValidationWorker.Outcome> settled = validationWorker.settleNext();

        assertTrue(settled.isPresent(), "验证队列必须有可结算项");
        assertEquals("PASS", settled.get().state());
        assertEquals("ALL_GATES_PASSED", settled.get().reasonCode());

        PlatformTask validated = taskMapper.selectOneById(loop.taskId());
        assertEquals("VALIDATED", validated.getState());
        // 基线在整个闭环中保持冻结：晋升不改写它。
        assertNotNull(validated.getBaselineJson());
        assertNull(validated.getFailureCode());
        assertEquals(loop.snapshot().getBaselineHash(),
            CandidateGitStore.sha256(validated.getBaselineJson()));

        // 唯一的晋升：同一 Run 只对应一条 SourceRevision。
        var revisions = revisionMapper.selectListByQuery(QueryWrapper.create().eq("runId", loop.runId()));
        assertEquals(1, revisions.size());
        SourceRevision revision = revisions.getFirst();
        assertEquals(loop.taskId(), revision.getTaskId());
        assertEquals(loop.snapshot().getCommitHash(), revision.getCommitHash());
        assertNotNull(revision.getValidationAttemptId());

        // 四类必需证据必须齐备、全部 PASS，且绑定同一个 Snapshot 与同一次 Platform 尝试。
        List<ValidationEvidence> evidence = evidenceMapper.selectListByQuery(
            QueryWrapper.create().eq("runId", loop.runId()));
        assertEquals(4, evidence.size());
        assertEquals(List.of("DATABASE", "ENGINEERING", "RUNTIME", "TASK_ACCEPTANCE"),
            evidence.stream().map(ValidationEvidence::getCategory).sorted().toList());
        assertEquals(1, evidence.stream().map(ValidationEvidence::getResult).distinct().count());
        assertEquals(1, evidence.stream().map(ValidationEvidence::getAttemptId).distinct().count());
        assertEquals(revision.getValidationAttemptId(), evidence.getFirst().getAttemptId());
        assertEquals(loop.snapshot().getCommitHash(), evidence.getFirst().getCommitHash());

        App application = appMapper.selectOneById(loop.applicationId());
        assertEquals(revision.getId(), application.getStableSourceRevision());
        assertEquals(PlatformOwnerVisibleStatus.VALIDATED, statusService.getStatus(loop.applicationId(), owner()).getStatus());
    }

    /**
     * AC5 的 Validation 失败路径。
     *
     * <p>失败必须落 Task `failed` 并保留冻结基线：不晋升任何版本，Owner 看得到「验证没有通过」，
     * 且仍有可追溯的候选 Snapshot。
     */
    @Test
    void oneFailingGateFailsTheTaskKeepsTheBaselineAndPromotesNothing() {
        when(gateRunner.validate(any(), any())).thenReturn(new CandidateFourGateExecutor.Report(
            passGate(),
            new CandidateFourGateExecutor.Gate(CandidateFourGateExecutor.Status.FAIL, "MIGRATION_UNSAFE"),
            passGate(),
            passGate()));

        Loop loop = runToSucceeded("我想要一个预约管理的小程序", "支持 14 天内预约", "可以提前 14 天预约");
        String baselineBefore = taskMapper.selectOneById(loop.taskId()).getBaselineJson();

        PlatformValidationWorker.Outcome settled = validationWorker.settleNext().orElseThrow();

        assertEquals("FAIL", settled.state());
        assertEquals("MIGRATION_UNSAFE", settled.reasonCode());
        PlatformTask failed = taskMapper.selectOneById(loop.taskId());
        assertEquals("FAILED", failed.getState());
        assertEquals("VALIDATION_FAILED", failed.getFailureCode());
        assertEquals(baselineBefore, failed.getBaselineJson(), "验证失败不得改写冻结基线");
        assertTrue(revisionMapper.selectCountByQuery(
            QueryWrapper.create().eq("runId", loop.runId())) == 0, "验证失败不得晋升任何版本");
        assertNull(appMapper.selectOneById(loop.applicationId()).getStableSourceRevision());

        // 必须重新读取：Loop 里那份是 settleNext 之前拍的快照，拿它断言等于什么都没验。
        PlatformApplicationStatusVO projected = statusService.getStatus(loop.applicationId(), owner());
        assertEquals(PlatformOwnerVisibleStatus.FAILED, projected.getStatus());
        assertEquals("验证没有通过，可以查看要求后重新提交需求。", projected.getFailureReason());
        assertFalse(projected.isAnswerRequired(), "验证失败不是业务歧义，不应向 Owner 提问");
    }

    /** AC5 的 `blocked` 路径与 AC3 的「答复前无 Sandbox 写入权」在真实库上的证据。 */
    @Test
    void blockedRequirementNeverReachesARunSoThereIsNoWriteAuthority() {
        long applicationId = newApplication();
        managementService.submitRequirement(applicationId, owner(), "我想要一个预约管理的小程序");
        var claim = claimNormalization(applicationId);
        PlatformNormalizationResultRequest blocked = new PlatformNormalizationResultRequest();
        blocked.setApplicationId(String.valueOf(applicationId));
        blocked.setTaskId(String.valueOf(claim.taskId()));
        blocked.setAttemptId(claim.attemptId());
        blocked.setOutcome(PlatformNormalizationResultRequest.OUTCOME_BLOCKED);
        blocked.setBlockingQuestion("客户可以提前几天预约？");
        blocked.setRequestId("normalize-blocked");
        workService.reportNormalization(blocked);

        assertEquals(0, runMapper.selectCountByQuery(QueryWrapper.create().eq("appId", applicationId)));
        assertTrue(workService.claimRun().isEmpty());
        assertNull(taskMapper.selectOneById(claim.taskId()).getBaselineJson());

        PlatformApplicationStatusVO projected = statusService.getStatus(applicationId, owner());
        assertEquals(PlatformOwnerVisibleStatus.BLOCKED, projected.getStatus());
        assertTrue(projected.isAnswerRequired());
        assertEquals("客户可以提前几天预约？", projected.getBlockingQuestion());
    }

    private Loop runToSucceeded(String requirementText, String requestedOutcome, String acceptanceTarget) {
        long applicationId = newApplication();
        managementService.submitRequirement(applicationId, owner(), requirementText);
        var claim = claimNormalization(applicationId);
        PlatformNormalizationResultRequest ready = new PlatformNormalizationResultRequest();
        ready.setApplicationId(String.valueOf(applicationId));
        ready.setTaskId(String.valueOf(claim.taskId()));
        ready.setAttemptId(claim.attemptId());
        ready.setOutcome(PlatformNormalizationResultRequest.OUTCOME_READY);
        ready.setRequestedOutcome(requestedOutcome);
        ready.setAcceptanceTarget(acceptanceTarget);
        ready.setRequestId("normalize-ready");
        workService.reportNormalization(ready);

        String runId = workService.claimRun().orElseThrow().getRunId();
        PlatformSandboxHandle sandboxHandle = new PlatformSandboxHandle("container-" + runId, runId, applicationId);
        when(sandboxExecutor.start(runId, applicationId)).thenReturn(sandboxHandle);
        when(sandboxExecutor.find(runId)).thenReturn(Optional.of(sandboxHandle));
        PlatformTask readyTask = taskMapper.selectOneById(claim.taskId());
        doAnswer(invocation -> {
            Path destination = invocation.getArgument(1, Path.class);
            writeWorkspaceArchive(destination, readyTask.getRequirementId());
            return null;
        }).when(sandboxExecutor).exportQuiesced(eq(sandboxHandle), any(), anyLong());

        // 受控执行：授予 Lease → 执行基线命令 → 冻结 Snapshot → 上报成功。
        PlatformRunLeaseGrantVO grant = executionService.grantLease(
            String.valueOf(applicationId), runId, "container=appbuild,network=none", "lease-1");
        Long fenceToken = grant.getLease().getFenceToken();
        // 与真实 Runtime 相同：先登记恢复检查点、再声明开始写入，之后 Platform 才接受
        // 改写 Workspace 的命令。未登记就发命令会被明确拒绝。
        executionService.prepareRecovery(String.valueOf(applicationId), runId, fenceToken, "prepare-1");
        executionService.beginExecution(String.valueOf(applicationId), runId, fenceToken, "begin-1");
        // 首次命令把 Run 从 LEASED 推到 EXECUTING，同时把 Task 从 ready 推到 executing。
        executionService.execute(String.valueOf(applicationId), runId, fenceToken, "true", 5, "command-1");
        executionService.freeze(String.valueOf(applicationId), runId, fenceToken, "freeze-1");
        executionService.reportResult(
            String.valueOf(applicationId), runId, fenceToken, "SUCCEEDED", "freeze-1", null, "result-1");

        PlatformTask task = taskMapper.selectOneById(claim.taskId());
        assertEquals("EXECUTING", task.getState());
        return new Loop(applicationId, claim.taskId(), runId,
            snapshotService.requireReady(applicationId, runId));
    }

    /**
     * 导出一次真实快照应有的 Workspace 内容。
     *
     * <p>首个候选版本的申报必须是 {@code changed}：此时 Task 没有 baseProfileVersion，
     * {@code unchanged} 在晋升时会因为「没有可比对的基线 Profile」被拒。{@code changed}
     * 携带初始 candidateProfile 与变更列表，由晋升路径生成 versionNumber = 1。
     */
    private void writeWorkspaceArchive(Path destination, Long requirementId) throws IOException {
        String manifest = "{\"disposition\":\"changed\","
            + "\"reason\":\"首个候选版本引入初始 Profile；此前 Application 没有可信 Profile 基线。\","
            + "\"diff\":{\"candidateProfile\":{\"language\":\"node\",\"packageManager\":\"npm\"},"
            + "\"changes\":[{\"path\":\"profile\",\"summary\":\"引入初始 Profile\"}]},"
            + "\"requirementId\":" + requirementId + "}";
        try (OutputStream out = Files.newOutputStream(destination);
             TarArchiveOutputStream tar = new TarArchiveOutputStream(out)) {
            putDirectory(tar, "workspace/");
            putDirectory(tar, "workspace/.platform/");
            putFile(tar, "workspace/" + PROFILE_MANIFEST, manifest.getBytes(StandardCharsets.UTF_8));
            putFile(tar, "workspace/package.json",
                "{\"name\":\"generated-app\",\"private\":true}\n".getBytes(StandardCharsets.UTF_8));
        }
    }

    private void putDirectory(TarArchiveOutputStream tar, String name) throws IOException {
        TarArchiveEntry entry = new TarArchiveEntry(name);
        entry.setMode(0755);
        tar.putArchiveEntry(entry);
        tar.closeArchiveEntry();
    }

    private void putFile(TarArchiveOutputStream tar, String name, byte[] content) throws IOException {
        TarArchiveEntry entry = new TarArchiveEntry(name);
        entry.setSize(content.length);
        entry.setMode(0644);
        tar.putArchiveEntry(entry);
        tar.write(content);
        tar.closeArchiveEntry();
    }

    private PlatformRequirementNormalizationService.Claim claimNormalization(long applicationId) {
        var item = workService.claimNormalization()
            .orElseThrow(() -> new AssertionError("expected a pending normalization work item"));
        return new PlatformRequirementNormalizationService.Claim(0L, applicationId,
            Long.parseLong(item.getRequirementId()), Long.parseLong(item.getTaskId()), item.getAttemptId());
    }

    private CandidateFourGateExecutor.Report passingReport() {
        return new CandidateFourGateExecutor.Report(passGate(), passGate(), passGate(), passGate());
    }

    private static CandidateFourGateExecutor.Gate passGate() {
        return new CandidateFourGateExecutor.Gate(CandidateFourGateExecutor.Status.PASS, "PASS");
    }

    private long newApplication() {
        return Long.parseLong(managementService.createApplication(owner(), "Product").getId());
    }

    private User owner() {
        User user = new User();
        user.setId(OWNER_ID);
        user.setUserRole("user");
        return user;
    }

    private static Path snapshotRoot() {
        try {
            return Files.createTempDirectory("issue80-loop-e2e-");
        } catch (IOException e) {
            throw new IllegalStateException("Cannot create test Git root", e);
        }
    }

    private record Loop(long applicationId, long taskId, String runId, CandidateSourceSnapshot snapshot) { }

    /**
     * AC5 的 `failed -> ready` 路径：Owner 重试在真实库上走完 D-06 的那条边。
     *
     * <p>本用例同时钉住两件此前只能靠人记住的事：
     * <ol>
     *   <li>重试创建<b>新 Run</b>，上一台 Run 的终态保持不变——它是上一次尝试的证据；</li>
     *   <li>Requirement 与冻结基线在重试前后逐字节相同，D-06 明文要求「不变」。</li>
     * </ol>
     */
    @Test
    void ownerRetryReturnsTheTaskToReadyWithANewRunAndAnUntouchedBaseline() {
        when(gateRunner.validate(any(), any())).thenReturn(new CandidateFourGateExecutor.Report(
            passGate(),
            new CandidateFourGateExecutor.Gate(CandidateFourGateExecutor.Status.FAIL, "MIGRATION_UNSAFE"),
            passGate(),
            passGate()));
        Loop loop = runToSucceeded("我想要一个预约管理的小程序", "支持 14 天内预约", "可以提前 14 天预约");
        validationWorker.settleNext().orElseThrow();
        PlatformTask failed = taskMapper.selectOneById(loop.taskId());
        assertEquals("FAILED", failed.getState());
        String baselineBeforeRetry = failed.getBaselineJson();
        Long requirementBeforeRetry = failed.getRequirementId();
        String firstRunId = loop.runId();
        long revisionCountBefore = revisionMapper.selectCountByQuery(
            QueryWrapper.create().eq("taskId", loop.taskId()));

        var outcome = retryService.requestRetry(
            loop.applicationId(), loop.taskId(), PlatformActor.OWNER, "按补充规则重跑", "retry-1");

        PlatformTask retried = taskMapper.selectOneById(loop.taskId());
        assertEquals("READY", retried.getState());
        assertEquals(baselineBeforeRetry, retried.getBaselineJson(), "D-06 要求重试不改变冻结基线");
        assertEquals(requirementBeforeRetry, retried.getRequirementId(), "D-06 要求重试不改变 Requirement");
        assertEquals(2, outcome.attemptNumber());
        assertNotEquals(firstRunId, outcome.runId());
        // 旧 Run 仍是失败终态：新 Run 不覆盖它。
        assertEquals("SUCCEEDED", runMapper.selectOneById(firstRunId).getState());
        assertEquals("CREATED", runMapper.selectOneById(outcome.runId()).getState());
        // 验证失败时不曾晋升，重试也不能凭空补出一个版本。
        assertEquals(revisionCountBefore, revisionMapper.selectCountByQuery(
            QueryWrapper.create().eq("taskId", loop.taskId())));

        // 受理了 Owner 重试就意味着状态可再次前进：新 Run 会被工作循环正常领取。
        assertTrue(workService.claimRun().isPresent());
        assertEquals(PlatformOwnerVisibleStatus.READY,
            statusService.getStatus(loop.applicationId(), owner()).getStatus());
    }

    /** 同一个 failed Task 只能被重试一次，否则 Task 停在 ready 而所有者以为还有一次未处理的失败。 */
    @Test
    void theSameFailedTaskCannotBeRetriedTwice() {
        when(gateRunner.validate(any(), any())).thenReturn(new CandidateFourGateExecutor.Report(
            passGate(),
            new CandidateFourGateExecutor.Gate(CandidateFourGateExecutor.Status.FAIL, "MIGRATION_UNSAFE"),
            passGate(),
            passGate()));
        Loop loop = runToSucceeded("我想要一个预约管理的小程序", "支持 14 天内预约", "可以提前 14 天预约");
        validationWorker.settleNext().orElseThrow();
        retryService.requestRetry(loop.applicationId(), loop.taskId(), PlatformActor.OWNER, null, "retry-1");

        // 第二次请求时 Task 已是 ready，不再是 failed：仍然必须被拒绝。
        assertEquals(40300, assertThrows(BusinessException.class, () -> retryService.requestRetry(
            loop.applicationId(), loop.taskId(), PlatformActor.OWNER, null, "retry-2")).getCode());
    }

    /** 非 Owner 主体不得触发重试，也不产生任何领域副作用。 */
    @Test
    void aNonOwnerCannotRequestARetry() {
        Loop loop = runToSucceeded("我想要一个预约管理的小程序", "支持 14 天内预约", "可以提前 14 天预约");
        String baseline = taskMapper.selectOneById(loop.taskId()).getBaselineJson();

        assertEquals(40101, assertThrows(BusinessException.class, () -> retryService.requestRetry(
            loop.applicationId(), loop.taskId(), PlatformActor.RUNTIME, null, "retry-1")).getCode());
        assertEquals("EXECUTING", taskMapper.selectOneById(loop.taskId()).getState());
        assertEquals(baseline, taskMapper.selectOneById(loop.taskId()).getBaselineJson());
        assertEquals(0, retryRequestMapper.selectCountByQuery(QueryWrapper.create().eq("taskId", loop.taskId())));
    }
}
