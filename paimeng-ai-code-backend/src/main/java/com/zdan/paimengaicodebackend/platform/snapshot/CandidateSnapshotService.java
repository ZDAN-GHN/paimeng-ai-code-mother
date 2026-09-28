package com.zdan.paimengaicodebackend.platform.snapshot;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.CandidateSourceSnapshotMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunLeaseService;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunState;
import com.zdan.paimengaicodebackend.platform.entity.CandidateSourceSnapshot;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRun;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxExecutor;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxHandle;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.Objects;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

@Slf4j
@Service
public class CandidateSnapshotService {
    private final CandidateSourceSnapshotMapper mapper;
    private final PlatformRunMapper runs;
    private final PlatformTaskMapper tasks;
    private final PlatformRunLeaseService leases;
    private final PlatformSandboxExecutor sandbox;
    private final CandidateGitStore git;
    private final SnapshotClaims claims;

    public CandidateSnapshotService(CandidateSourceSnapshotMapper mapper, PlatformRunMapper runs,
                                    PlatformTaskMapper tasks, PlatformRunLeaseService leases,
                                    PlatformSandboxExecutor sandbox, CandidateGitStore git, SnapshotClaims claims) {
        this.mapper = mapper;
        this.runs = runs;
        this.tasks = tasks;
        this.leases = leases;
        this.sandbox = sandbox;
        this.git = git;
        this.claims = claims;
    }

    public CandidateSourceSnapshot freeze(long appId, String runId, long fence, String requestId) {
        if (requestId == null || requestId.isBlank() || requestId.length() > 64) throw denied();
        PlatformRun run = runs.selectOneById(runId);
        if (run == null || !Objects.equals(run.getApplicationId(), appId)
            || !PlatformRunState.EXECUTING.name().equals(run.getState())) throw denied();
        PlatformTask task = tasks.selectOneById(run.getTaskId());
        if (task == null || !Objects.equals(task.getApplicationId(), appId)
            || task.getBaselineJson() == null || task.getBaselineJson().isBlank()) throw denied();
        String baselineHash = CandidateGitStore.sha256(task.getBaselineJson());
        CandidateSourceSnapshot claimed = claims.claim(appId, runId, fence, requestId, task, baselineHash);
        if ("READY".equals(claimed.getStatus())) return requireReady(appId, runId);
        Path stage = null;
        Path capture = null;
        RuntimeException primaryFailure = null;
        try {
            PlatformSandboxHandle handle = sandbox.find(runId).orElseThrow(this::denied);
            if (!Objects.equals(handle.applicationId(), appId)) throw denied();
            stage = git.stage();
            capture = Files.createTempFile(stage.getParent(), ".snapshot-capture-", ".tar");
            Files.delete(capture); // Docker receiver creates the file exclusively.
            sandbox.exportQuiesced(handle, capture, SnapshotArchive.MAX_ARCHIVE_BYTES);
            try (var archive = Files.newInputStream(capture)) {
                SnapshotArchive.extract(archive, stage);
            }
            Files.delete(capture);
            capture = null;
            // The claim rules out further commands; a stale lease cannot publish after extraction.
            leases.requireHeldLease(runId, fence, requestId);
            CandidateGitStore.GitIdentity identity = git.commit(appId, runId, baselineHash, stage);
            claims.finish(claimed, identity.commitHash(), identity.treeHash());
            return requireReady(appId, runId);
        } catch (IOException e) {
            log.error("Snapshot freeze failed, appId={}, runId={}, requestId={}, category=io",
                appId, runId, requestId, e);
            primaryFailure = new BusinessException(ErrorCode.OPERATION_ERROR, "Snapshot Git 存储失败", e);
            abortClaim(claimed, primaryFailure);
            throw primaryFailure;
        } catch (RuntimeException e) {
            primaryFailure = e;
            abortClaim(claimed, e);
            throw e;
        } finally {
            try {
                cleanup(capture, stage);
            } catch (RuntimeException cleanupFailure) {
                if (primaryFailure == null) throw cleanupFailure;
                primaryFailure.addSuppressed(cleanupFailure);
                log.error("Snapshot cleanup failed, appId={}, runId={}, requestId={}",
                    appId, runId, requestId, cleanupFailure);
            }
        }
    }

    private void abortClaim(CandidateSourceSnapshot claim, RuntimeException failure) {
        try {
            claims.abort(claim);
        } catch (RuntimeException abortFailure) {
            failure.addSuppressed(abortFailure);
            log.error("Snapshot abort failed, runId={}, requestId={}",
                claim.getRunId(), claim.getRequestId(), abortFailure);
        }
    }

    private void cleanup(Path capture, Path stage) {
        RuntimeException failure = null;
        if (capture != null) {
            try {
                Files.deleteIfExists(capture);
            } catch (IOException e) {
                failure = new BusinessException(ErrorCode.OPERATION_ERROR,
                    "Snapshot 原始归档清理失败", e);
            }
        }
        try {
            deleteStage(stage);
        } catch (RuntimeException e) {
            if (failure == null) failure = e;
            else failure.addSuppressed(e);
        }
        if (failure != null) throw failure;
    }

    /** Reject missing, mismatched or corrupted persisted references, including before Run success. */
    public CandidateSourceSnapshot requireReady(long appId, String runId) {
        CandidateSourceSnapshot snapshot = mapper.selectOneById(runId);
        PlatformRun run = runs.selectOneById(runId);
        PlatformTask task = run == null ? null : tasks.selectOneById(run.getTaskId());
        if (snapshot == null || !"READY".equals(snapshot.getStatus()) || run == null || task == null
            || !Objects.equals(snapshot.getApplicationId(), appId)
            || !Objects.equals(run.getApplicationId(), appId)
            || !Objects.equals(snapshot.getTaskId(), run.getTaskId())
            || !Objects.equals(task.getApplicationId(), appId)
            || !Objects.equals(snapshot.getBaselineHash(), CandidateGitStore.sha256(task.getBaselineJson()))
            || !Objects.equals(snapshot.getBaseSourceRevision(), task.getBaseSourceRevision())
            || snapshot.getCommitHash() == null || snapshot.getTreeHash() == null) throw denied();
        try {
            git.verify(appId, runId, new CandidateGitStore.GitIdentity(
                snapshot.getCommitHash(), snapshot.getTreeHash()));
        } catch (IOException e) {
            log.error("Snapshot verification failed, appId={}, runId={}, category=git-object",
                appId, runId, e);
            throw new BusinessException(ErrorCode.OPERATION_ERROR, "Snapshot Git 对象不可恢复", e);
        }
        return snapshot;
    }

    /** Internal restore only: never accepts caller-provided paths, hashes or archive bytes. */
    public void restore(long appId, String runId, PlatformSandboxHandle handle) {
        CandidateSourceSnapshot snapshot = requireReady(appId, runId);
        if (!Objects.equals(handle.applicationId(), appId) || !Objects.equals(handle.runId(), runId)
            || !Objects.equals(sandbox.find(runId).orElse(null), handle)) throw denied();
        try {
            Process archive = git.archive(appId, new CandidateGitStore.GitIdentity(
                snapshot.getCommitHash(), snapshot.getTreeHash()));
            try (var bytes = archive.getInputStream()) {
                sandbox.restore(handle, bytes);
                if (!archive.waitFor(30, java.util.concurrent.TimeUnit.SECONDS) || archive.exitValue() != 0) {
                    throw new IOException("Git 导出失败");
                }
            } finally {
                archive.destroyForcibly();
            }
        } catch (IOException e) {
            log.error("Snapshot restore failed, appId={}, runId={}, category=io", appId, runId, e);
            throw new BusinessException(ErrorCode.OPERATION_ERROR, "Snapshot 恢复失败", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new BusinessException(ErrorCode.OPERATION_ERROR, "Snapshot 恢复被中断");
        }
    }

    private void deleteStage(Path stage) {
        if (stage == null) return;
        try (var entries = Files.walk(stage)) {
            for (Path path : entries.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
        } catch (IOException e) {
            // Temporary files contain untrusted source: fail closed when cleanup is incomplete.
            throw new BusinessException(ErrorCode.OPERATION_ERROR, "Snapshot 临时文件清理失败", e);
        }
    }

    private BusinessException denied() {
        return new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Run 尚无可恢复的可信 Snapshot");
    }
}
