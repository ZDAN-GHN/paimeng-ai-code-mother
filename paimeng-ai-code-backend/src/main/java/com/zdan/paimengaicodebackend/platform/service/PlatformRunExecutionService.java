package com.zdan.paimengaicodebackend.platform.service;

import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.platform.domain.PlatformActor;
import com.zdan.paimengaicodebackend.platform.domain.PlatformLogicalRelationValidator;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunLeaseService;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunState;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunTransitionService;
import com.zdan.paimengaicodebackend.platform.domain.PlatformTaskLifecycleService;
import com.zdan.paimengaicodebackend.platform.domain.PlatformTaskState;
import com.zdan.paimengaicodebackend.platform.domain.TaskExecutionBaselineCodec;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRun;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRunLease;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRunRecoveryCheckpoint;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxExecutor;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxHandle;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxProperties;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateGitStore;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateSnapshotService;
import com.zdan.paimengaicodebackend.platform.vo.PlatformExecutionCapabilitiesVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformRunCommandResultVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformRunLeaseGrantVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformRunLeaseVO;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 受控 Run 执行的编排（Issue #77 / T-05）。
 *
 * <p>三条编排约束不是实现偏好，改动前须先改对应决定：
 *
 * <ul>
 *   <li><strong>actor 不接受请求自报。</strong>调用方只能选择调哪个端点，不能声明自己是谁。
 *       Lease 操作记为 {@code RUNTIME}，状态裁决记为 {@code PLATFORM}（状态机只允许
 *       Platform 裁决 Run 状态）。鉴权延后期间尤其如此：自报身份等于没有身份。</li>
 *   <li><strong>编排顺序由状态机钉死</strong>（见 {@code PlatformTaskStateMachine}）：
 *       授予 Lease → {@code CREATED→LEASED} → {@code LEASED→EXECUTING} → 释放 Lease
 *       → 进入终态。终态转换要求确实已无 Lease 行，因此结果上报必须先停容器、再释放
 *       Lease、最后转终态。</li>
 *   <li><strong>Lease 事实一律实查。</strong>每个写操作都携 fence token 问
 *       {@code platform_run_lease} 真实行，不信任调用方的自报持有状态（D-06）。</li>
 * </ul>
 */
@Slf4j
@Service
public class PlatformRunExecutionService {

    /** 允许上报的 Run 终态。非终态值不得经结果上报写入。 */
    private static final Set<PlatformRunState> REPORTABLE_OUTCOMES = Set.of(
        PlatformRunState.SUCCEEDED,
        PlatformRunState.FAILED,
        PlatformRunState.CANCELLED
    );

    /** 业务歧义阻断的原因码；同时用于 Run 终态和 Task blocked 转换的审计。 */
    private static final String BLOCK_REASON_CODE = "BUSINESS_CLARIFICATION_REQUIRED";

    private final PlatformRunLeaseService leaseService;
    private final PlatformRunTransitionService runTransitionService;
    private final PlatformLogicalRelationValidator relationValidator;
    private final PlatformSandboxExecutor sandboxExecutor;
    private final PlatformSandboxProperties sandboxProperties;
    private final PlatformRunMapper runMapper;
    private final PlatformTaskMapper taskMapper;
    private final TaskExecutionBaselineCodec baselineCodec;
    private final CandidateSnapshotService snapshotService;
    private final PlatformRunRecoveryService recoveryService;
    private final PlatformTaskLifecycleService taskLifecycle;

    public PlatformRunExecutionService(
        PlatformRunLeaseService leaseService,
        PlatformRunTransitionService runTransitionService,
        PlatformLogicalRelationValidator relationValidator,
        PlatformSandboxExecutor sandboxExecutor,
        PlatformSandboxProperties sandboxProperties,
        PlatformRunMapper runMapper,
        PlatformTaskMapper taskMapper,
        TaskExecutionBaselineCodec baselineCodec,
        PlatformRunRecoveryService recoveryService,
        CandidateSnapshotService snapshotService,
        PlatformTaskLifecycleService taskLifecycle
    ) {
        this.leaseService = leaseService;
        this.runTransitionService = runTransitionService;
        this.relationValidator = relationValidator;
        this.sandboxExecutor = sandboxExecutor;
        this.sandboxProperties = sandboxProperties;
        this.runMapper = runMapper;
        this.taskMapper = taskMapper;
        this.baselineCodec = baselineCodec;
        this.recoveryService = recoveryService;
        this.snapshotService = snapshotService;
        this.taskLifecycle = taskLifecycle;
    }

    /**
     * 授予写入 Lease、推进 {@code CREATED→LEASED}、启动 Sandbox，返回 Lease 与真实环境能力。
     *
     * <p>三步刻意不放在同一事务：Sandbox 启动是外部副作用，事务回滚无法收回已创建的容器。
     * 因此把它放在最后，并在失败时显式补偿——顺序同样由状态机决定（{@code LEASED→FAILED}
     * 要求已无 Lease 行，所以先释放再转 FAILED）。
     */
    public PlatformRunLeaseGrantVO grantLease(
        String applicationIdText,
        String runId,
        String reasonCode,
        String requestId
    ) {
        return grantLease(applicationIdText, runId, reasonCode, requestId, null);
    }

    public PlatformRunLeaseGrantVO grantLease(
        String applicationIdText,
        String runId,
        String reasonCode,
        String requestId,
        Integer recoveryProtocolVersion
    ) {
        long startedNanos = System.nanoTime();
        Long applicationId = parseApplicationId(applicationIdText);
        requireRunIdentity(runId, requestId);
        if (recoveryProtocolVersion != null && recoveryProtocolVersion != 1) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "Run 接管协议版本不支持");
        }
        requireRunBelongsToDeclaredApplication(applicationId, runId);

        PlatformRun run = runMapper.selectOneById(runId);
        if (run == null || run.getTaskId() == null) {
            throw new BusinessException(ErrorCode.NOT_FOUND_ERROR, "Run 的 Task 不存在");
        }
        boolean resuming = PlatformRunState.LEASED.name().equals(run.getState());
        if (resuming && !Integer.valueOf(1).equals(recoveryProtocolVersion)) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Runtime 不支持同一 Run 的安全接管协议");
        }
        if (!resuming && !PlatformRunState.CREATED.name().equals(run.getState())) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Run 状态不可安全接管");
        }
        relationValidator.requireTaskBelongsToApplication(applicationId, run.getTaskId());
        PlatformTask task = taskMapper.selectOneById(run.getTaskId());
        if (task == null) {
            throw new BusinessException(ErrorCode.NOT_FOUND_ERROR, "Run 的 Task 不存在");
        }
        // 缺失或未知基线版本必须在授予 Lease 和启动容器之前拒绝。
        if (task.getBaselineJson() == null || task.getBaselineJson().isBlank()) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "TaskExecutionBaseline 不能为空");
        }
        baselineCodec.deserialize(task.getBaselineJson());

        PlatformRunLease lease;
        if (resuming) {
            PlatformRunRecoveryCheckpoint checkpoint = recoveryService.requireResumable(applicationId, runId);
            lease = leaseService.grant(runId, PlatformActor.RUNTIME, reasonCode, requestId);
            try {
                recoveryService.claim(
                    runId, checkpoint.getFenceToken(), lease.getFenceToken(),
                    checkpoint.getContainerId(), requestId
                );
            } catch (RuntimeException claimFailure) {
                try {
                    leaseService.release(
                        runId, lease.getFenceToken(), PlatformActor.PLATFORM,
                        "RUN_RECOVERY_CLAIM_FAILED", requestId + "-compensate-release"
                    );
                } catch (RuntimeException releaseFailure) {
                    claimFailure.addSuppressed(releaseFailure);
                    log.error("Platform Run recovery compensation failed, runId: {}, requestId: {}",
                        runId, requestId, releaseFailure);
                }
                throw claimFailure;
            }
        } else {
            lease = leaseService.grant(runId, PlatformActor.RUNTIME, reasonCode, requestId);
            try {
                runTransitionService.transition(
                    runId,
                    PlatformRunState.CREATED,
                    PlatformRunState.LEASED,
                    PlatformActor.PLATFORM,
                    reasonCode,
                    null,
                    requestId
                );
            } catch (RuntimeException transitionFailure) {
                try {
                    leaseService.release(
                        runId,
                        lease.getFenceToken(),
                        PlatformActor.PLATFORM,
                        "RUN_TRANSITION_FAILED",
                        requestId + "-compensate-release"
                    );
                } catch (RuntimeException releaseFailure) {
                    transitionFailure.addSuppressed(releaseFailure);
                    log.error("Platform Run transition compensation failed, runId: {}, requestId: {}",
                        runId, requestId, releaseFailure);
                }
                throw transitionFailure;
            }

            try {
                sandboxExecutor.start(runId, applicationId);
            } catch (RuntimeException startFailure) {
                compensateFailedStart(runId, lease.getFenceToken(), requestId, startFailure);
                throw startFailure;
            }
        }

        PlatformRunLeaseGrantVO granted = new PlatformRunLeaseGrantVO();
        granted.setLease(toLeaseVO(lease));
        granted.setCapabilities(buildCapabilities());
        granted.setBaselineJson(task.getBaselineJson());
        log.info(
            "Platform Run execution grant completed, applicationId: {}, runId: {}, fenceToken: {}, resumed: {}, requestId: {}, result: success, durationMs: {}",
            applicationId,
            runId,
            lease.getFenceToken(),
            resuming,
            requestId,
            TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos)
        );
        return granted;
    }

    /** Freeze this Run's tmpfs before the Runtime reports SUCCEEDED. */
    public void freeze(String applicationIdText, String runId, Long fenceToken, String requestId) {
        Long applicationId = parseApplicationId(applicationIdText);
        requireRunIdentity(runId, requestId);
        requireFenceToken(fenceToken);
        requireRunBelongsToDeclaredApplication(applicationId, runId);
        snapshotService.freeze(applicationId, runId, fenceToken, requestId);
    }

    /** Register a pristine Sandbox as recoverable before entering the Pi session. */
    public void prepareRecovery(String applicationIdText, String runId, Long fenceToken, String requestId) {
        Long applicationId = parseApplicationId(applicationIdText);
        requireRunIdentity(runId, requestId);
        requireFenceToken(fenceToken);
        requireRunBelongsToDeclaredApplication(applicationId, runId);
        recoveryService.prepare(applicationId, runId, fenceToken, requestId);
    }

    /** Atomically close the recovery window before the first outbound model request. */
    public void beginExecution(String applicationIdText, String runId, Long fenceToken, String requestId) {
        Long applicationId = parseApplicationId(applicationIdText);
        requireRunIdentity(runId, requestId);
        requireFenceToken(fenceToken);
        requireRunBelongsToDeclaredApplication(applicationId, runId);
        recoveryService.begin(applicationId, runId, fenceToken, requestId);
        // begin() 会把 Run 推到 EXECUTING；Task 必须跟着走，否则 Owner 会看到 Task 停在
        // ready 而 Run 已经在写 Workspace。
        markTaskExecutingIfNeeded(runId, requestId + "-task-executing");
    }

    /** 续租。fence 落后、Lease 过期或已达续租上限由 Lease 服务拒绝。 */
    public PlatformRunLeaseVO renewLease(
        String applicationIdText,
        String runId,
        Long fenceToken,
        String reasonCode,
        String requestId
    ) {
        Long applicationId = parseApplicationId(applicationIdText);
        requireRunIdentity(runId, requestId);
        requireFenceToken(fenceToken);
        requireRunBelongsToDeclaredApplication(applicationId, runId);

        return toLeaseVO(
            leaseService.renew(runId, fenceToken, PlatformActor.RUNTIME, reasonCode, requestId)
        );
    }

    /**
     * 停止 Sandbox 并释放 Lease。
     *
     * <p>先停容器再释放 Lease：反过来会出现「已无写入权但容器还在跑」的窗口。容器停止失败
     * 时整个请求失败而不是静默继续（{@code .agents/rules/errors.md}：不吞掉失败），
     * Lease 留待 TTL 过期被收割。
     */
    public void releaseLease(
        String applicationIdText,
        String runId,
        Long fenceToken,
        String reasonCode,
        String requestId
    ) {
        long startedNanos = System.nanoTime();
        Long applicationId = parseApplicationId(applicationIdText);
        requireRunIdentity(runId, requestId);
        requireFenceToken(fenceToken);
        requireRunBelongsToDeclaredApplication(applicationId, runId);
        leaseService.requireHeldLease(runId, fenceToken, requestId);

        stopSandboxIfPresent(runId);
        leaseService.release(runId, fenceToken, PlatformActor.RUNTIME, reasonCode, requestId);
        log.info(
            "Platform Run execution release completed, applicationId: {}, runId: {}, fenceToken: {}, requestId: {}, result: success, durationMs: {}",
            applicationId,
            runId,
            fenceToken,
            requestId,
            TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos)
        );
    }

    /**
     * 在该 Run 的 Sandbox 内执行命令。
     *
     * <p>fence 校验后、容器使用前会<strong>二次实查 Lease</strong>。Lease 过期是时间事实，
     * 中间那次 Docker 查询本身可能耗时，一次校验无法覆盖这个窗口。二次校验把窗口压到微秒级，
     * 但不消除它——真正的正确性边界在结果上报处：终态写入同样要求持有有效 Lease，
     * 且每个 Run 有独立容器与独立 tmpfs，过期写入者写不进别的 Run。
     */
    public PlatformRunCommandResultVO execute(
        String applicationIdText,
        String runId,
        Long fenceToken,
        String command,
        Integer timeoutSeconds,
        String requestId
    ) {
        long startedNanos = System.nanoTime();
        Long applicationId = parseApplicationId(applicationIdText);
        requireRunIdentity(runId, requestId);
        requireFenceToken(fenceToken);
        if (command == null || command.isBlank()) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "执行命令不能为空");
        }
        int effectiveTimeout = resolveCommandTimeout(timeoutSeconds);
        requireRunBelongsToDeclaredApplication(applicationId, runId);
        leaseService.requireHeldLease(runId, fenceToken, requestId);

        PlatformSandboxHandle handle = sandboxExecutor.find(runId).orElseThrow(() ->
            new BusinessException(ErrorCode.NOT_FOUND_ERROR, "Run 的 Sandbox 容器不存在")
        );
        // 二次实查：见方法注释。此处拒绝的写入会留下 Lease 过期审计事件。
        leaseService.requireHeldLease(runId, fenceToken, requestId);
        recoveryService.requireCommandAdmitted(runId, fenceToken);
        advanceToExecutingIfNeeded(runId, requestId);
        recoveryService.startCommand(applicationId, runId, fenceToken, command, requestId);

        StringBuilder stdout = new StringBuilder();
        StringBuilder stderr = new StringBuilder();
        int exitCode = sandboxExecutor.exec(
            handle,
            command,
            effectiveTimeout,
            chunk -> stdout.append(new String(chunk, StandardCharsets.UTF_8)),
            chunk -> stderr.append(new String(chunk, StandardCharsets.UTF_8))
        );
        recoveryService.finishCommand(runId, requestId, exitCode);

        PlatformRunCommandResultVO result = new PlatformRunCommandResultVO();
        result.setRunId(runId);
        result.setExitCode(exitCode);
        result.setStdout(stdout.toString());
        result.setStderr(stderr.toString());
        result.setDurationMs(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos));
        log.info(
            "Platform Run execution command completed, applicationId: {}, runId: {}, fenceToken: {}, exitCode: {}, timeoutSeconds: {}, requestId: {}, result: success, durationMs: {}",
            applicationId,
            runId,
            fenceToken,
            exitCode,
            effectiveTimeout,
            requestId,
            result.getDurationMs()
        );
        return result;
    }

    /**
     * 上报 Run 终态：停容器 → 释放 Lease → 转终态。
     *
     * <p>期望状态从库中实读而非假定为 {@code EXECUTING}：一次命令都没执行就失败的 Run 仍是
     * {@code LEASED}，写死 {@code EXECUTING} 会让这条真实路径无法上报。状态机负责裁决该
     * 起点是否允许进入所报终态。
     */
    public void reportResult(
        String applicationIdText,
        String runId,
        Long fenceToken,
        String outcome,
        String reasonCode,
        String evidenceRef,
        String requestId
    ) {
        long startedNanos = System.nanoTime();
        Long applicationId = parseApplicationId(applicationIdText);
        requireRunIdentity(runId, requestId);
        requireFenceToken(fenceToken);
        PlatformRunState targetState = parseReportableOutcome(outcome);
        requireRunBelongsToDeclaredApplication(applicationId, runId);
        leaseService.requireHeldLease(runId, fenceToken, requestId);

        PlatformRunState currentState = readRunState(runId);
        if (targetState == PlatformRunState.SUCCEEDED
            && (currentState != PlatformRunState.EXECUTING
                || snapshotService.requireReady(applicationId, runId) == null)) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Run 成功前必须冻结 Snapshot");
        }
        stopSandboxIfPresent(runId);
        leaseService.release(runId, fenceToken, PlatformActor.RUNTIME, reasonCode, requestId);
        runTransitionService.transition(
            runId,
            currentState,
            targetState,
            PlatformActor.PLATFORM,
            reasonCode,
            evidenceRef,
            requestId
        );
        log.info(
            "Platform Run execution report completed, applicationId: {}, runId: {}, from: {}, to: {}, fenceToken: {}, requestId: {}, result: success, durationMs: {}",
            applicationId,
            runId,
            currentState,
            targetState,
            fenceToken,
            requestId,
            TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos)
        );
    }

    /**
     * 受控执行中发现决定性业务歧义：停容器 → 释放 Lease → Run 进入终态 → Task 落 blocked。
     *
     * <p>Agent 只能提出问题，不能改写 Task 状态。顺序由 D-06 决定：Task 的
     * {@code executing→blocked} 要求「Run 已停止且不再持有 Lease」，因此必须先释放写入权
     * 再转状态，否则会出现「已阻断但仍可写入」的窗口。
     *
     * <p>Run 落在 {@code CANCELLED} 而不是 {@code FAILED}：D-06 的 Run 状态集合是锁定的，
     * {@code SUCCEEDED} 会触发验证队列、{@code FAILED} 表示不可恢复的执行失败，两者都会把
     * 「等一个业务答复」误报成执行结果。D-06 同时要求 blocked（有冻结基线）时原 Task 保持
     * blocked 并为重新归一化创建新 Task，因此这次取消不会被自动恢复。
     *
     * <p>这条边曾一度只有实现方自述的论证；D-06 的 Run 表现已显式认下「Agent 提出决定性
     * 业务歧义 → {@code cancelled}（{@code BUSINESS_CLARIFICATION_REQUIRED}）」，并要求用终态
     * 转换事件的 {@code actorType} 与 Owner 取消区分。改动终态统计口径时必须按
     * {@code actorType} / {@code reasonCode} 过滤，不能只看 {@code platform_run.state}。
     */
    @Transactional(rollbackFor = Exception.class)
    public void blockForClarification(
        String applicationIdText,
        String runId,
        Long fenceToken,
        String blockingQuestion,
        String requestId
    ) {
        long startedNanos = System.nanoTime();
        Long applicationId = parseApplicationId(applicationIdText);
        requireRunIdentity(runId, requestId);
        requireFenceToken(fenceToken);
        // 先校验问题再拆执行：不合格的问题如果留到落库前才发现，一次受控执行已经被停掉了。
        PlatformTaskLifecycleService.requireAnswerableQuestion(blockingQuestion);
        requireRunBelongsToDeclaredApplication(applicationId, runId);
        leaseService.requireHeldLease(runId, fenceToken, requestId);

        PlatformRunState currentState = readRunState(runId);
        if (currentState != PlatformRunState.LEASED && currentState != PlatformRunState.EXECUTING) {
            throw new BusinessException(
                ErrorCode.FORBIDDEN_ERROR, "Run 已进入终态，无法再按业务歧义阻断");
        }
        stopSandboxIfPresent(runId);
        leaseService.release(runId, fenceToken, PlatformActor.RUNTIME, BLOCK_REASON_CODE, requestId);
        runTransitionService.transition(
            runId,
            currentState,
            PlatformRunState.CANCELLED,
            PlatformActor.PLATFORM,
            BLOCK_REASON_CODE,
            null,
            requestId + "-run-cancelled"
        );
        taskLifecycle.markBlockedAfterRunStopped(
            taskIdForRun(runId), blockingQuestion, BLOCK_REASON_CODE, requestId + "-task-blocked");
        log.info(
            "Platform Run execution blocked for clarification, applicationId: {}, runId: {}, fenceToken: {}, requestId: {}, result: success, durationMs: {}",
            applicationId,
            runId,
            fenceToken,
            requestId,
            TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos)
        );
    }

    /** 读取真实环境能力。字段值一律取自实际配置与 Lease 常量，不复制字面量。 */
    public PlatformExecutionCapabilitiesVO buildCapabilities() {
        PlatformExecutionCapabilitiesVO capabilities = new PlatformExecutionCapabilitiesVO();
        capabilities.setWorkspacePath("/workspace");
        // tmpfs 实现下 Workspace 不跨容器留存（AD-016）。
        capabilities.setWorkspacePersistent(false);
        capabilities.setWritablePaths(List.of("/workspace", "/tmp"));
        // 容器以 --network none 创建，外连必然失败。
        capabilities.setNetworkAccessAvailable(false);
        capabilities.setReadonlyRootFilesystem(true);
        capabilities.setMemoryLimitMb(sandboxProperties.getMemoryLimitMb());
        capabilities.setCpuLimit(sandboxProperties.getCpuLimit());
        capabilities.setPidsLimit(sandboxProperties.getPidsLimit());
        capabilities.setWorkspaceTmpfsSizeMb(sandboxProperties.getWorkspaceTmpfsSizeMb());
        capabilities.setTmpfsSizeMb(sandboxProperties.getTmpfsSizeMb());
        capabilities.setLeaseTtlSeconds(PlatformRunLeaseService.LEASE_TTL_SECONDS);
        capabilities.setLeaseRenewIntervalSeconds(PlatformRunLeaseService.LEASE_RENEW_INTERVAL_SECONDS);
        capabilities.setLeaseMaxRenewCount(PlatformRunLeaseService.LEASE_MAX_RENEW_COUNT);
        capabilities.setDefaultCommandTimeoutSeconds(sandboxProperties.getDefaultCommandTimeoutSeconds());
        capabilities.setMaxCommandTimeoutSeconds(sandboxProperties.getMaxCommandTimeoutSeconds());
        return capabilities;
    }

    /**
     * Sandbox 启动失败的补偿：释放 Lease 并把 Run 推进 FAILED。
     *
     * <p>补偿自身失败时只记日志——此时已有一个真实的启动失败要抛给调用方，用补偿失败覆盖它
     * 会丢掉首个根因（{@code .agents/rules/errors.md}：保留首个根因异常）。残留 Lease 由
     * TTL 过期收割。
     */
    private void compensateFailedStart(
        String runId,
        Long fenceToken,
        String requestId,
        RuntimeException startFailure
    ) {
        log.error(
            "Platform Run execution start failed, runId: {}, fenceToken: {}, requestId: {}, errorClass: {}, compensating: release-lease-then-fail-run",
            runId,
            fenceToken,
            requestId,
            startFailure.getClass().getSimpleName()
        );
        try {
            leaseService.release(
                runId,
                fenceToken,
                PlatformActor.PLATFORM,
                "SANDBOX_START_FAILED",
                requestId + "-compensate-release"
            );
            runTransitionService.transition(
                runId,
                PlatformRunState.LEASED,
                PlatformRunState.FAILED,
                PlatformActor.PLATFORM,
                "SANDBOX_START_FAILED",
                null,
                requestId + "-compensate-fail"
            );
        } catch (RuntimeException compensationFailure) {
            log.error(
                "Platform Run execution compensation failed, runId: {}, requestId: {}, errorClass: {}, result: lease-left-to-ttl",
                runId,
                requestId,
                compensationFailure.getClass().getSimpleName(),
                compensationFailure
            );
        }
    }

    /**
     * 首次执行命令时推进 {@code LEASED→EXECUTING}；已在 EXECUTING 则不重复转换。
     *
     * <p>Task 的 {@code ready→executing} 放在同一处而不是授予 Lease 时：D-06 要求
     * 「Runtime 已获得受控执行上下文」，而上下文成立的那一刻是第一条命令被接纳，
     * 不是 Lease 被授予。这样 Task 的 {@code executing} 与 Run 的 {@code executing}
     * 永远同义，Owner 的状态投影也不会出现「Task 在跑但 Run 还没开始」。
     */
    private void advanceToExecutingIfNeeded(String runId, String requestId) {
        PlatformRunState currentState = readRunState(runId);
        if (currentState == PlatformRunState.EXECUTING) {
            return;
        }
        runTransitionService.transition(
            runId,
            currentState,
            PlatformRunState.EXECUTING,
            PlatformActor.PLATFORM,
            "RUNTIME_COMMAND_RECEIVED",
            null,
            requestId + "-executing"
        );
        markTaskExecutingIfNeeded(runId, requestId + "-task-executing");
    }

    /**
     * Task {@code ready -> executing}，只在当前仍是 ready 时执行。
     *
     * <p>Run 有两条进入 {@code EXECUTING} 的路径：显式 {@code beginExecution} 与首条命令；
     * 两条都要让 Task 跟着走，才不变量「Task executing 等价于 Run executing」才成立。
     * 幂等写成「仅在 ready 时推进」而不是靠状态机拒绝重复转换，这样任一路径重复触发都无害。
     */
    private void markTaskExecutingIfNeeded(String runId, String requestId) {
        Long taskId = taskIdForRun(runId);
        PlatformTask task = taskMapper.selectOneById(taskId);
        if (task == null || !PlatformTaskState.READY.name().equals(task.getState())) {
            return;
        }
        // 证据引用是冻结基线的指纹：它解释了「这次受控执行写的是哪一份输入」。
        taskLifecycle.markExecutionStarted(taskId, CandidateGitStore.sha256(task.getBaselineJson()),
            "CONTROLLED_EXECUTION_STARTED", requestId);
    }

    private Long taskIdForRun(String runId) {
        PlatformRun run = runMapper.selectOneByQuery(QueryWrapper.create().eq("id", runId));
        if (run == null || run.getTaskId() == null) {
            throw new BusinessException(ErrorCode.NOT_FOUND_ERROR, "Run 的 Task 不存在");
        }
        return run.getTaskId();
    }

    private void stopSandboxIfPresent(String runId) {
        sandboxExecutor.find(runId).ifPresent(sandboxExecutor::stop);
    }

    private PlatformRunState readRunState(String runId) {
        PlatformRun run = runMapper.selectOneByQuery(QueryWrapper.create().eq("id", runId));
        if (run == null || run.getState() == null) {
            throw new BusinessException(ErrorCode.NOT_FOUND_ERROR, "Run 不存在或状态缺失");
        }
        try {
            return PlatformRunState.valueOf(run.getState());
        } catch (IllegalArgumentException exception) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "Run 状态不合法");
        }
    }

    /**
     * 归属校验：请求声明的 Application 必须真的拥有该 Run。
     *
     * <p>入站鉴权延后期间这是唯一的跨 Application 拦截点，不可省略。它拦不住同时知道两个
     * 标识的调用方——那需要真正的鉴权——但能拦住串号的 Runtime 把写入落到别的 Application。
     */
    private void requireRunBelongsToDeclaredApplication(Long applicationId, String runId) {
        relationValidator.requireActiveApplication(applicationId);
        relationValidator.requireRunBelongsToApplication(applicationId, runId);
    }

    private int resolveCommandTimeout(Integer timeoutSeconds) {
        if (timeoutSeconds == null) {
            return sandboxProperties.getDefaultCommandTimeoutSeconds();
        }
        if (timeoutSeconds <= 0) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "命令超时必须为正数");
        }
        if (timeoutSeconds > sandboxProperties.getMaxCommandTimeoutSeconds()) {
            throw new BusinessException(
                ErrorCode.PARAMS_ERROR,
                "命令超时超过上限 " + sandboxProperties.getMaxCommandTimeoutSeconds() + " 秒"
            );
        }
        return timeoutSeconds;
    }

    private PlatformRunState parseReportableOutcome(String outcome) {
        if (outcome == null || outcome.isBlank()) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "Run 终态不能为空");
        }
        PlatformRunState state;
        try {
            state = PlatformRunState.valueOf(outcome);
        } catch (IllegalArgumentException exception) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "Run 终态不合法");
        }
        if (!REPORTABLE_OUTCOMES.contains(state)) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "只能上报 Run 终态");
        }
        return state;
    }

    private Long parseApplicationId(String applicationIdText) {
        if (applicationIdText == null || applicationIdText.isBlank()) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "Application 标识不能为空");
        }
        try {
            return Long.valueOf(applicationIdText);
        } catch (NumberFormatException exception) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "Application 标识不合法");
        }
    }

    private void requireRunIdentity(String runId, String requestId) {
        if (runId == null || runId.isBlank() || requestId == null || requestId.isBlank()) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "受控执行参数不完整");
        }
    }

    private void requireFenceToken(Long fenceToken) {
        if (fenceToken == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "fence token 不能为空");
        }
    }

    private PlatformRunLeaseVO toLeaseVO(PlatformRunLease lease) {
        PlatformRunLeaseVO vo = new PlatformRunLeaseVO();
        vo.setRunId(lease.getRunId());
        vo.setApplicationId(String.valueOf(lease.getApplicationId()));
        vo.setTaskId(String.valueOf(lease.getTaskId()));
        vo.setFenceToken(lease.getFenceToken());
        vo.setGrantedAt(lease.getGrantedAt());
        vo.setExpiresAt(lease.getExpiresAt());
        vo.setRenewCount(lease.getRenewCount() == null ? 0 : lease.getRenewCount());
        return vo;
    }
}
