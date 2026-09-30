package com.zdan.paimengaicodebackend.platform.validation;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformValidationQueueEventMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformValidationQueueMapper;
import com.zdan.paimengaicodebackend.platform.entity.PlatformValidationQueue;
import com.zdan.paimengaicodebackend.platform.snapshot.SnapshotReference;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.transaction.support.TransactionSynchronizationManager;

class PlatformValidationQueueServiceTest {

    private PlatformValidationQueueMapper queueMapper;
    private PlatformValidationQueueEventMapper eventMapper;
    private PlatformValidationQueueService queue;

    @BeforeEach
    void setUp() {
        queueMapper = org.mockito.Mockito.mock(PlatformValidationQueueMapper.class);
        eventMapper = org.mockito.Mockito.mock(PlatformValidationQueueEventMapper.class);
        queue = new PlatformValidationQueueService(queueMapper, eventMapper);
    }

    @Test
    void missingClaimCannotFinish() {
        assertThrows(BusinessException.class, () -> queue.complete(null, "PASS", "ALL_GATES_PASS"));
        verifyNoInteractions(queueMapper);
    }

    @Test
    void registrationRequiresATransactionSoRunAndQueueShareOneCommit() {
        assertThrows(BusinessException.class, () -> queue.enqueue(101, 201, "run-one"),
            "脱离事务登记队列会让 Run 成功与队列登记失去同生共死");
        verifyNoInteractions(queueMapper);
    }

    @Test
    void registrationRejectsIncompleteIdentity() {
        TransactionSynchronizationManager.setActualTransactionActive(true);
        try {
            assertThrows(BusinessException.class, () -> queue.enqueue(0, 201, "run-one"));
            assertThrows(BusinessException.class, () -> queue.enqueue(101, 201, " "));
            verifyNoInteractions(queueMapper);
        } finally {
            TransactionSynchronizationManager.setActualTransactionActive(false);
        }
    }

    @Test
    void registrationWritesQueueRowAndAuditEventTogether() {
        TransactionSynchronizationManager.setActualTransactionActive(true);
        try {
            when(queueMapper.insertSelective(any(PlatformValidationQueue.class))).thenReturn(1);
            when(eventMapper.insertSelective(any())).thenReturn(1);
            assertDoesNotThrow(() -> queue.enqueue(101, 201, "run-one"));
            ArgumentCaptor<PlatformValidationQueue> row = ArgumentCaptor.forClass(PlatformValidationQueue.class);
            verify(queueMapper).insertSelective(row.capture());
            assertEquals(101L, row.getValue().getEventId());
            assertEquals(201L, row.getValue().getAppId());
            assertEquals("run-one", row.getValue().getRunId());
            assertEquals("PENDING", row.getValue().getState());
            verify(eventMapper).insertSelective(any());
        } finally {
            TransactionSynchronizationManager.setActualTransactionActive(false);
        }
    }

    @Test
    void registrationIsAtomicSoAFailedAuditInsertRollsBackTheQueueRow() {
        TransactionSynchronizationManager.setActualTransactionActive(true);
        try {
            when(queueMapper.insertSelective(any(PlatformValidationQueue.class))).thenReturn(1);
            when(eventMapper.insertSelective(any())).thenReturn(0);
            assertThrows(BusinessException.class, () -> queue.enqueue(101, 201, "run-one"));
        } finally {
            TransactionSynchronizationManager.setActualTransactionActive(false);
        }
    }

    @Test
    void nothingToClaimReturnsEmpty() {
        when(queueMapper.selectClaimable()).thenReturn(null);
        assertTrue(queue.claimNext().isEmpty());
        verifyNoInteractions(eventMapper);
    }

    @Test
    void crashedAttemptReceivesNewIdentityBeforeRetry() {
        PlatformValidationQueue row = new PlatformValidationQueue();
        row.setEventId(101L);
        row.setAppId(201L);
        row.setRunId("run-one");
        row.setAttemptId("old-attempt");
        row.setAttemptNumber(1);
        when(queueMapper.selectClaimable()).thenReturn(row);
        when(queueMapper.claim(anyLong(), anyString(), eq(2))).thenReturn(1);
        when(eventMapper.insertSelective(any())).thenReturn(1);
        PlatformValidationQueueService.Claim retry = queue.claimNext().orElseThrow();
        assertEquals("old-attempt", retry.replacedAttemptId());
        assertEquals("run-one", retry.runId());
        assertTrue(!"old-attempt".equals(retry.attemptId()));
        verify(queueMapper).claim(eq(101L), eq(retry.attemptId()), eq(2));
    }

    @Test
    void exhaustedAttemptNumberIsRefusedInsteadOfOverflowing() {
        PlatformValidationQueue row = new PlatformValidationQueue();
        row.setEventId(101L);
        row.setAttemptNumber(Integer.MAX_VALUE);
        when(queueMapper.selectClaimable()).thenReturn(row);
        assertThrows(BusinessException.class, () -> queue.claimNext());
        verify(queueMapper, org.mockito.Mockito.never()).claim(anyLong(), anyString(), eq(0));
    }

    @Test
    void passNeedsFourPlatformIssuedResultsFromSameAttemptAndAnActiveLease() {
        PlatformValidationQueueService.Claim claim =
            new PlatformValidationQueueService.Claim(101L, 201L, "run-one", "attempt-1", null);
        when(queueMapper.countAuthoritativePassEvidence("run-one", "attempt-1")).thenReturn(0);
        assertThrows(BusinessException.class, () -> queue.complete(claim, "PASS", "ALL_GATES_PASS"));
        verify(queueMapper, org.mockito.Mockito.never()).complete(anyLong(), anyString(), anyString(),
            anyString(), anyString());

        when(queueMapper.countAuthoritativePassEvidence("run-one", "attempt-1")).thenReturn(1);
        when(queueMapper.complete(eq(101L), eq("run-one"), eq("attempt-1"), eq("PASS"), eq("ALL_GATES_PASS")))
            .thenReturn(1);
        when(eventMapper.insertSelective(any())).thenReturn(1);
        assertDoesNotThrow(() -> queue.complete(claim, "PASS", "ALL_GATES_PASS"));
        assertThrows(BusinessException.class, () -> queue.complete(claim, "pass", "ALL_GATES_PASS"));
        assertThrows(BusinessException.class, () -> queue.complete(claim, "PASS", "raw error text"));
    }

    @Test
    void failedResultsSkipTheAuthoritativeEvidenceCheckButStillNeedTheLeaseCas() {
        PlatformValidationQueueService.Claim claim =
            new PlatformValidationQueueService.Claim(101L, 201L, "run-one", "attempt-1", null);
        when(queueMapper.complete(anyLong(), anyString(), anyString(), eq("FAIL"), eq("RUNTIME_FAILED")))
            .thenReturn(0);
        assertThrows(BusinessException.class, () -> queue.complete(claim, "FAIL", "RUNTIME_FAILED"),
            "租约已过期或已被抢占时不得落终态");
        verify(queueMapper, org.mockito.Mockito.never())
            .countAuthoritativePassEvidence(anyString(), anyString());
    }

    @Test
    void promotionRequiresExactlyOnePassedAttemptForTheSameRun() {
        SnapshotReference reference = new SnapshotReference(201, 301, "run-one",
            "d".repeat(64), null, "b".repeat(40), "c".repeat(40));
        when(queueMapper.selectPassedAttempts(201L, "run-one")).thenReturn(List.of("attempt-1"));
        assertEquals("attempt-1", queue.requirePassed(reference));

        when(queueMapper.selectPassedAttempts(201L, "run-one")).thenReturn(List.of());
        assertThrows(BusinessException.class, () -> queue.requirePassed(reference),
            "从未通过的 Run 不能被晋升");
        when(queueMapper.selectPassedAttempts(201L, "run-one"))
            .thenReturn(List.of("attempt-1", "22222222-3333-4444-5555-666666666666"));
        assertThrows(BusinessException.class, () -> queue.requirePassed(reference),
            "一个 Run 出现两条 PASS 属于歧义，不得采信");
        when(queueMapper.selectPassedAttempts(201L, "run-one"))
            .thenReturn(java.util.Arrays.asList("attempt-1", null));
        assertThrows(BusinessException.class, () -> queue.requirePassed(reference),
            "缺少尝试身份的 PASS 不构成权威证明");
    }

    @Test
    void promotionCannotBeDrivenByACallerSuppliedSnapshot() {
        assertThrows(BusinessException.class, () -> queue.requirePassed(null));
        verifyNoInteractions(queueMapper);
    }
}
