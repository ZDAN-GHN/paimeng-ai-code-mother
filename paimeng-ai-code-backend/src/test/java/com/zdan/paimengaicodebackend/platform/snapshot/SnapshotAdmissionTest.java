package com.zdan.paimengaicodebackend.platform.snapshot;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.CandidateSourceSnapshotMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunCommandRequestMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunLeaseService;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunTransitionService;
import com.zdan.paimengaicodebackend.platform.entity.CandidateSourceSnapshot;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRun;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxExecutor;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxHandle;
import com.zdan.paimengaicodebackend.platform.service.PlatformRunRecoveryService;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunRecoveryCheckpointMapper;
import java.io.ByteArrayOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;
import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SnapshotAdmissionTest {
    private static final String RUN = "run-1";
    private static final long APP = 101L;

    @Test
    void rejectsFreezeWhilePriorCommandIsUnfinished() {
        CandidateSourceSnapshotMapper mapper = mock(CandidateSourceSnapshotMapper.class);
        when(mapper.lockRun(RUN)).thenReturn(RUN);
        when(mapper.countUnfinishedCommands(RUN)).thenReturn(1L);
        PlatformTask task = new PlatformTask();
        task.setId(9L);
        SnapshotClaims claims = new SnapshotClaims(mapper, mock(PlatformRunLeaseService.class));

        assertThrows(BusinessException.class,
            () -> claims.claim(APP, RUN, 3L, "freeze-1", task, "baseline"));
        verify(mapper, never()).insert(any(CandidateSourceSnapshot.class));
    }

    @Test
    void refusesCommandAfterFreezeClaimBeforeSandboxExec() {
        CandidateSourceSnapshotMapper snapshots = mock(CandidateSourceSnapshotMapper.class);
        when(snapshots.lockRun(RUN)).thenReturn(RUN);
        when(snapshots.selectOneById(RUN)).thenReturn(new CandidateSourceSnapshot());
        PlatformRunCommandRequestMapper commands = mock(PlatformRunCommandRequestMapper.class);
        PlatformRunRecoveryService recovery = new PlatformRunRecoveryService(
            mock(PlatformRunRecoveryCheckpointMapper.class), snapshots, commands,
            mock(PlatformRunMapper.class), mock(PlatformRunLeaseService.class),
            mock(PlatformRunTransitionService.class), mock(PlatformSandboxExecutor.class));

        assertThrows(BusinessException.class,
            () -> recovery.startCommand(APP, RUN, 3L, "write source", "command-2"));
        verify(commands, never()).insert(any());
    }

    @Test
    void failedQuiescenceCannotWriteGitOrPublishReady(@TempDir Path root) throws Exception {
        CandidateSourceSnapshotMapper snapshots = mock(CandidateSourceSnapshotMapper.class);
        PlatformRunMapper runs = mock(PlatformRunMapper.class);
        PlatformTaskMapper tasks = mock(PlatformTaskMapper.class);
        PlatformSandboxExecutor sandbox = mock(PlatformSandboxExecutor.class);
        CandidateGitStore git = mock(CandidateGitStore.class);
        SnapshotClaims claims = mock(SnapshotClaims.class);
        PlatformRun run = new PlatformRun();
        run.setId(RUN);
        run.setApplicationId(APP);
        run.setTaskId(9L);
        run.setState("EXECUTING");
        when(runs.selectOneById(RUN)).thenReturn(run);
        PlatformTask task = new PlatformTask();
        task.setId(9L);
        task.setApplicationId(APP);
        task.setBaselineJson("baseline");
        when(tasks.selectOneById(9L)).thenReturn(task);
        CandidateSourceSnapshot claim = new CandidateSourceSnapshot();
        claim.setRunId(RUN);
        claim.setStatus("FREEZING");
        when(claims.claim(anyLong(), anyString(), anyLong(), anyString(), any(), anyString()))
            .thenReturn(claim);
        when(sandbox.find(RUN)).thenReturn(Optional.of(new PlatformSandboxHandle("container-1", RUN, APP)));
        when(git.stage()).thenReturn(Files.createDirectory(root.resolve("stage")));
        doThrow(new BusinessException(ErrorCode.OPERATION_ERROR, "writers remain"))
            .when(sandbox).exportQuiesced(any(), any(Path.class), anyLong());
        CandidateSnapshotService service = new CandidateSnapshotService(
            snapshots, runs, tasks, mock(PlatformRunLeaseService.class), sandbox, git, claims);

        assertThrows(BusinessException.class, () -> service.freeze(APP, RUN, 3L, "freeze-1"));
        verify(git, never()).commit(anyLong(), anyString(), anyString(), any());
        verify(claims, never()).finish(any(), anyString(), anyString());
        verify(claims).abort(claim);
    }

    @Test
    void gitCommitBeforeFailedDbFinishAbortsWithoutLosingOriginalError(@TempDir Path root) throws Exception {
        PlatformRunMapper runs = mock(PlatformRunMapper.class);
        PlatformTaskMapper tasks = mock(PlatformTaskMapper.class);
        PlatformSandboxExecutor sandbox = mock(PlatformSandboxExecutor.class);
        CandidateGitStore git = mock(CandidateGitStore.class);
        SnapshotClaims claims = mock(SnapshotClaims.class);
        PlatformRun run = new PlatformRun();
        run.setId(RUN);
        run.setApplicationId(APP);
        run.setTaskId(9L);
        run.setState("EXECUTING");
        when(runs.selectOneById(RUN)).thenReturn(run);
        PlatformTask task = new PlatformTask();
        task.setId(9L);
        task.setApplicationId(APP);
        task.setBaselineJson("baseline");
        when(tasks.selectOneById(9L)).thenReturn(task);
        CandidateSourceSnapshot claim = new CandidateSourceSnapshot();
        claim.setRunId(RUN);
        claim.setRequestId("freeze-1");
        claim.setFenceToken(3L);
        claim.setStatus("FREEZING");
        when(claims.claim(anyLong(), anyString(), anyLong(), anyString(), any(), anyString()))
            .thenReturn(claim);
        when(sandbox.find(RUN)).thenReturn(Optional.of(new PlatformSandboxHandle("container-1", RUN, APP)));
        when(git.stage()).thenReturn(Files.createDirectory(root.resolve("stage")));
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (TarArchiveOutputStream tar = new TarArchiveOutputStream(bytes)) {
            TarArchiveEntry directory = new TarArchiveEntry("workspace/");
            tar.putArchiveEntry(directory);
            tar.closeArchiveEntry();
            TarArchiveEntry file = new TarArchiveEntry("workspace/source.txt");
            file.setSize(6);
            tar.putArchiveEntry(file);
            tar.write("source".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            tar.closeArchiveEntry();
        }
        doAnswer(invocation -> {
            Files.write(invocation.getArgument(1, Path.class), bytes.toByteArray());
            return null;
        }).when(sandbox).exportQuiesced(any(), any(Path.class), anyLong());
        when(git.commit(anyLong(), anyString(), anyString(), any()))
            .thenReturn(new CandidateGitStore.GitIdentity("a".repeat(40), "b".repeat(40)));
        BusinessException firstFailure = new BusinessException(ErrorCode.OPERATION_ERROR, "DB unavailable");
        doThrow(firstFailure).when(claims).finish(any(), anyString(), anyString());
        BusinessException abortFailure = new BusinessException(ErrorCode.OPERATION_ERROR, "abort unavailable");
        doThrow(abortFailure).when(claims).abort(claim);
        CandidateSnapshotService service = new CandidateSnapshotService(
            mock(CandidateSourceSnapshotMapper.class), runs, tasks, mock(PlatformRunLeaseService.class),
            sandbox, git, claims);

        BusinessException thrown = assertThrows(BusinessException.class,
            () -> service.freeze(APP, RUN, 3L, "freeze-1"));
        assertSame(firstFailure, thrown);
        assertSame(abortFailure, thrown.getSuppressed()[0]);
        verify(git).commit(anyLong(), anyString(), anyString(), any());
        verify(claims).abort(claim);
    }
}
