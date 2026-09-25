package com.zdan.paimengaicodebackend.platform.service;

import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunCommandRequestMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunRecoveryCheckpointMapper;
import com.zdan.paimengaicodebackend.platform.domain.PlatformActor;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunLeaseService;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunState;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunTransitionService;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRun;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRunCommandRequest;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRunRecoveryCheckpoint;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxExecutor;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxHandle;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.LocalDateTime;
import java.util.HexFormat;
import java.util.Objects;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * A recovery checkpoint is written only by the new Runtime before its first Pi request.
 * Historical LEASED Runs have no checkpoint and cannot be presumed request-free.
 */
@Service
public class PlatformRunRecoveryService {

    private static final String PREPARED = "PREPARED";
    private static final String STARTED = "STARTED";
    private static final String COMPLETED = "COMPLETED";

    private final PlatformRunRecoveryCheckpointMapper checkpointMapper;
    private final PlatformRunCommandRequestMapper commandMapper;
    private final PlatformRunMapper runMapper;
    private final PlatformRunLeaseService leaseService;
    private final PlatformRunTransitionService transitionService;
    private final PlatformSandboxExecutor sandboxExecutor;

    public PlatformRunRecoveryService(
        PlatformRunRecoveryCheckpointMapper checkpointMapper,
        PlatformRunCommandRequestMapper commandMapper,
        PlatformRunMapper runMapper,
        PlatformRunLeaseService leaseService,
        PlatformRunTransitionService transitionService,
        PlatformSandboxExecutor sandboxExecutor
    ) {
        this.checkpointMapper = checkpointMapper;
        this.commandMapper = commandMapper;
        this.runMapper = runMapper;
        this.leaseService = leaseService;
        this.transitionService = transitionService;
        this.sandboxExecutor = sandboxExecutor;
    }

    public void prepare(Long applicationId, String runId, long fenceToken, String requestId) {
        requireRequestId(requestId);
        requireState(runId, PlatformRunState.LEASED);
        leaseService.requireHeldLease(runId, fenceToken, requestId);
        PlatformSandboxHandle handle = requirePristineSandbox(applicationId, runId);
        leaseService.requireHeldLease(runId, fenceToken, requestId);

        PlatformRunRecoveryCheckpoint existing = checkpointMapper.selectOneById(runId);
        if (existing != null) {
            if (PREPARED.equals(existing.getPhase())
                && Objects.equals(existing.getApplicationId(), applicationId)
                && Objects.equals(existing.getFenceToken(), fenceToken)
                && Objects.equals(existing.getContainerId(), handle.containerId())) {
                return;
            }
            throw denied("Run 恢复检查点已变化");
        }

        PlatformRunRecoveryCheckpoint checkpoint = new PlatformRunRecoveryCheckpoint();
        checkpoint.setRunId(runId);
        checkpoint.setApplicationId(applicationId);
        checkpoint.setFenceToken(fenceToken);
        checkpoint.setContainerId(handle.containerId());
        checkpoint.setPhase(PREPARED);
        checkpoint.setPreparedRequestId(requestId);
        try {
            checkpointMapper.insert(checkpoint);
        } catch (DuplicateKeyException duplicate) {
            throw denied("Run 恢复检查点已被其他请求创建");
        }
    }

    /** CAS and Run transition share one transaction: no Pi request can start before both commit. */
    @Transactional(rollbackFor = Exception.class)
    public void begin(Long applicationId, String runId, long fenceToken, String requestId) {
        requireRequestId(requestId);
        leaseService.requireHeldLease(runId, fenceToken, requestId);
        requireState(runId, PlatformRunState.LEASED);
        PlatformRunRecoveryCheckpoint update = new PlatformRunRecoveryCheckpoint();
        update.setPhase(STARTED);
        update.setBeginRequestId(requestId);
        if (checkpointMapper.updateByQuery(
            update,
            true,
            QueryWrapper.create().eq("runId", runId).eq("appId", applicationId)
                .eq("fenceToken", fenceToken).eq("phase", PREPARED)
        ) != 1) {
            throw denied("Run 请求状态不可确认，拒绝开始执行");
        }
        transitionService.transition(
            runId,
            PlatformRunState.LEASED,
            PlatformRunState.EXECUTING,
            PlatformActor.PLATFORM,
            "RUNTIME_ENGINE_STARTED",
            null,
            requestId
        );
    }

    /** Prove all four conditions before granting a new Lease; the subsequent CAS settles races. */
    public PlatformRunRecoveryCheckpoint requireResumable(Long applicationId, String runId) {
        requireState(runId, PlatformRunState.LEASED);
        PlatformRunRecoveryCheckpoint checkpoint = checkpointMapper.selectOneById(runId);
        if (checkpoint == null || !PREPARED.equals(checkpoint.getPhase())
            || !Objects.equals(checkpoint.getApplicationId(), applicationId)
            || leaseService.hasActiveLeaseForRun(runId)) {
            throw denied("Run 的 Lease 或外部请求状态不可安全接管");
        }
        PlatformSandboxHandle handle = requirePristineSandbox(applicationId, runId);
        if (!Objects.equals(handle.containerId(), checkpoint.getContainerId())) {
            throw denied("Run 的原 Sandbox 容器已变化");
        }
        return checkpoint;
    }

    /** The old Runtime's begin CAS and this claim CAS cannot both succeed. */
    public void claim(
        String runId,
        long oldFenceToken,
        long newFenceToken,
        String containerId,
        String requestId
    ) {
        PlatformRunRecoveryCheckpoint update = new PlatformRunRecoveryCheckpoint();
        update.setFenceToken(newFenceToken);
        update.setResumeRequestId(requestId);
        if (checkpointMapper.updateByQuery(
            update,
            true,
            QueryWrapper.create().eq("runId", runId).eq("fenceToken", oldFenceToken)
                .eq("containerId", containerId).eq("phase", PREPARED)
        ) != 1) {
            throw denied("Run 接管竞争失败，原请求可能已开始");
        }
    }

    /** Commit the idempotency key before executing the Docker command. */
    @Transactional(rollbackFor = Exception.class)
    public void startCommand(
        Long applicationId,
        String runId,
        long fenceToken,
        String command,
        String requestId
    ) {
        requireRequestId(requestId);
        leaseService.requireHeldLease(runId, fenceToken, requestId);
        requireCommandAdmitted(runId, fenceToken);
        PlatformRunCommandRequest record = new PlatformRunCommandRequest();
        record.setApplicationId(applicationId);
        record.setRunId(runId);
        record.setRequestId(requestId);
        record.setFenceToken(fenceToken);
        record.setCommandHash(sha256(command));
        record.setStatus(STARTED);
        try {
            commandMapper.insert(record);
        } catch (DuplicateKeyException duplicate) {
            throw denied("命令 requestId 已受理，拒绝重复执行");
        }
    }

    public void requireCommandAdmitted(String runId, long fenceToken) {
        PlatformRunRecoveryCheckpoint checkpoint = checkpointMapper.selectOneById(runId);
        if (checkpoint == null || !STARTED.equals(checkpoint.getPhase())
            || !Objects.equals(checkpoint.getFenceToken(), fenceToken)) {
            throw denied("首次模型请求尚未登记，拒绝执行 Sandbox 命令");
        }
    }

    public void finishCommand(String runId, String requestId, int exitCode) {
        PlatformRunCommandRequest update = new PlatformRunCommandRequest();
        update.setStatus(COMPLETED);
        update.setExitCode(exitCode);
        update.setFinishedAt(LocalDateTime.now());
        if (commandMapper.updateByQuery(
            update,
            true,
            QueryWrapper.create().eq("runId", runId).eq("requestId", requestId).eq("status", STARTED)
        ) != 1) {
            throw new BusinessException(ErrorCode.OPERATION_ERROR, "Sandbox 命令结果未能持久确认");
        }
    }

    private PlatformSandboxHandle requirePristineSandbox(Long applicationId, String runId) {
        PlatformSandboxHandle handle = sandboxExecutor.find(runId).orElseThrow(() ->
            denied("Run 的原 Sandbox 容器不存在")
        );
        if (!Objects.equals(handle.applicationId(), applicationId)) {
            throw denied("Run 的 Sandbox 归属不可确认");
        }
        sandboxExecutor.requirePristineWorkspace(handle);
        return handle;
    }

    private void requireState(String runId, PlatformRunState expected) {
        PlatformRun run = runMapper.selectOneById(runId);
        if (run == null || !expected.name().equals(run.getState())) {
            throw denied("Run 状态不可安全接管");
        }
    }

    private void requireRequestId(String requestId) {
        if (requestId == null || requestId.isBlank() || requestId.length() > 64) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "requestId 必须为 1 至 64 个字符");
        }
    }

    private String sha256(String command) {
        try {
            return HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(command.getBytes(StandardCharsets.UTF_8))
            );
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 不可用", impossible);
        }
    }

    private BusinessException denied(String message) {
        return new BusinessException(ErrorCode.FORBIDDEN_ERROR, message);
    }
}
