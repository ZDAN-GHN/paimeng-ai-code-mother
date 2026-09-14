package com.zdan.paimengaicodebackend.service;

import com.zdan.paimengaicodebackend.ai.agent.AgentProperties;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ConcurrentRunException;
import com.zdan.paimengaicodebackend.mapper.GenerationRunMapper;
import com.zdan.paimengaicodebackend.model.dto.run.AgentCompleteRequest;
import com.zdan.paimengaicodebackend.model.dto.run.CreditFreezeRequest;
import com.zdan.paimengaicodebackend.model.dto.run.RunCreateRequest;
import com.zdan.paimengaicodebackend.model.dto.run.RunUpdateRequest;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.model.entity.CreditLedger;
import com.zdan.paimengaicodebackend.model.entity.GenerationRun;
import com.zdan.paimengaicodebackend.model.entity.User;
import com.zdan.paimengaicodebackend.model.enums.AgentCompleteStatusEnum;
import com.zdan.paimengaicodebackend.model.enums.CreditLedgerStatusEnum;
import com.zdan.paimengaicodebackend.model.vo.CreditFreezeVO;
import com.zdan.paimengaicodebackend.model.vo.RunVO;
import com.zdan.paimengaicodebackend.service.impl.GenerationRunServiceImpl;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.redisson.api.RRateLimiter;
import org.redisson.api.RedissonClient;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;


class GenerationRunServiceImplTest {

    private GenerationRunMapper mapper;
    private AppService appService;
    private ChatHistoryService chatHistoryService;
    private CreditService creditService;
    private RedissonClient redissonClient;
    private RRateLimiter rateLimiter;
    private GenerationRunServiceImpl service;

    @BeforeEach
    void setUp() {
        mapper = mock(GenerationRunMapper.class);
        appService = mock(AppService.class);
        chatHistoryService = mock(ChatHistoryService.class);
        creditService = mock(CreditService.class);
        redissonClient = mock(RedissonClient.class);
        rateLimiter = mock(RRateLimiter.class);
        when(redissonClient.getRateLimiter(anyString())).thenReturn(rateLimiter);
        service = new GenerationRunServiceImpl(appService, chatHistoryService, redissonClient, new AgentProperties(), creditService);
        ReflectionTestUtils.setField(service, "mapper", mapper);
    }

    private RunCreateRequest createRequest(String runId, long appId, String phase) {
        RunCreateRequest request = new RunCreateRequest();
        request.setRunId(runId);
        request.setAppId(appId);
        request.setUserId(1L);
        request.setPhase(phase);
        return request;
    }

    private GenerationRun run(String runId, long appId, String phase) {
        GenerationRun run = new GenerationRun();
        run.setRunId(runId);
        run.setAppId(appId);
        run.setUserId(1L);
        run.setPhase(phase);
        return run;
    }


    @Test
    void createRunInsertsNewRun() {
        when(mapper.selectOneById("run-new")).thenReturn(null);
        when(mapper.selectListByQuery(any())).thenReturn(List.of());
        when(mapper.insert(any(GenerationRun.class), anyBoolean())).thenReturn(1);

        RunVO vo = service.createRun(createRequest("run-new", 1L, "interview"));

        assertNotNull(vo);
        assertEquals("run-new", vo.getRunId());
        assertEquals("interview", vo.getPhase());
        assertNotNull(vo.getStartedTime());
        verify(mapper, times(1)).insert(any(GenerationRun.class), anyBoolean());
    }


    @Test
    void createRunIdempotentReturnsExisting() {
        when(mapper.selectOneById("run-dup")).thenReturn(run("run-dup", 1L, "coding"));

        RunVO vo = service.createRun(createRequest("run-dup", 1L, "interview"));

        assertNotNull(vo);
        assertEquals("coding", vo.getPhase());
        verify(mapper, never()).insert(any(GenerationRun.class));
    }


    @Test
    void createRunRejectsConcurrentActiveRun() {
        when(mapper.selectOneById("run-2")).thenReturn(null);
        when(mapper.selectListByQuery(any())).thenReturn(List.of(run("run-1", 1L, "coding")));

        ConcurrentRunException ex = assertThrows(ConcurrentRunException.class,
                () -> service.createRun(createRequest("run-2", 1L, "interview")));
        assertEquals("当前有进行中的任务", ex.getMessage());
        verify(mapper, never()).insert(any(GenerationRun.class));
    }


    @Test
    void createRunAllowsAfterTerminalRun() {
        when(mapper.selectOneById("run-2")).thenReturn(null);
        when(mapper.selectListByQuery(any())).thenReturn(List.of());
        when(mapper.insert(any(GenerationRun.class), anyBoolean())).thenReturn(1);

        RunVO vo = service.createRun(createRequest("run-2", 1L, "interview"));

        assertNotNull(vo);
        verify(mapper, times(1)).insert(any(GenerationRun.class), anyBoolean());
    }


    @Test
    void createRunRejectsInvalidPhase() {
        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.createRun(createRequest("run-x", 1L, "not-a-phase")));
        assertEquals("phase 非法", ex.getMessage());
    }


    @Test
    void createRunRejectsInvalidJsonContext() {
        RunCreateRequest request = createRequest("run-x", 1L, "interview");
        request.setContext("not json");
        BusinessException ex = assertThrows(BusinessException.class, () -> service.createRun(request));
        assertEquals("context 必须是合法 JSON", ex.getMessage());
    }


    @Test
    void updateRunIdempotentSkipsWhenUnchanged() {
        when(mapper.selectOneById("run-1")).thenReturn(run("run-1", 1L, "coding"));
        RunUpdateRequest request = new RunUpdateRequest();
        request.setPhase("coding");

        RunVO vo = service.updateRun("run-1", request);

        assertEquals("coding", vo.getPhase());
        verify(mapper, never()).update(any(GenerationRun.class));
    }


    @Test
    void updateRunAppliesChangesAndSetsFinishedTimeOnTerminal() {
        GenerationRun existing = run("run-1", 1L, "coding");
        GenerationRun refreshed = run("run-1", 1L, "done");
        refreshed.setFinishedTime(java.time.LocalDateTime.of(2026, 9, 4, 10, 0));
        when(mapper.selectOneById("run-1")).thenReturn(existing, refreshed);
        when(mapper.update(any(GenerationRun.class), anyBoolean())).thenReturn(1);

        RunUpdateRequest request = new RunUpdateRequest();
        request.setPhase("done");
        RunVO vo = service.updateRun("run-1", request);

        assertEquals("done", vo.getPhase());
        assertNotNull(vo.getFinishedTime());
        verify(mapper, times(1)).update(argThat(run -> run.getFinishedTime() != null), anyBoolean());
    }


    @Test
    void updateRunNotFoundThrows() {
        when(mapper.selectOneById("nope")).thenReturn(null);
        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.updateRun("nope", new RunUpdateRequest()));
        assertEquals("运行不存在", ex.getMessage());
    }


    @Test
    void getLatestNonTerminalRunReturnsNullWhenNone() {
        when(mapper.selectListByQuery(any())).thenReturn(List.of());
        assertNull(service.getLatestNonTerminalRun(1L, null));
    }


    @Test
    void getLatestNonTerminalRunReturnsRun() {
        when(mapper.selectListByQuery(any())).thenReturn(List.of(run("run-1", 1L, "wireframe_pending")));
        RunVO vo = service.getLatestNonTerminalRun(1L, null);
        assertNotNull(vo);
        assertEquals("run-1", vo.getRunId());
    }


    @Test
    void createRunConcurrentUnderThreadsExactlyOneSucceeds() throws Exception {

        AtomicReference<List<GenerationRun>> activeRuns = new AtomicReference<>(new ArrayList<>());
        when(mapper.selectOneById(anyString())).thenAnswer(inv -> {
            String runId = inv.getArgument(0);
            for (GenerationRun r : activeRuns.get()) {
                if (r.getRunId().equals(runId)) {
                    return r;
                }
            }
            return null;
        });
        when(mapper.selectListByQuery(any())).thenAnswer(inv -> activeRuns.get());
        when(mapper.insert(any(GenerationRun.class), anyBoolean())).thenAnswer(inv -> {
            GenerationRun r = inv.getArgument(0);
            List<GenerationRun> next = new ArrayList<>(activeRuns.get());
            next.add(r);
            activeRuns.set(next);
            return 1;
        });

        int threads = 2;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        CountDownLatch ready = new CountDownLatch(threads);
        CountDownLatch start = new CountDownLatch(1);
        AtomicInteger success = new AtomicInteger();
        AtomicInteger conflict = new AtomicInteger();
        for (int i = 0; i < threads; i++) {
            final int idx = i;
            pool.submit(() -> {
                ready.countDown();
                try {
                    start.await();
                    service.createRun(createRequest("run-conc-" + idx, 99L, "interview"));
                    success.incrementAndGet();
                } catch (ConcurrentRunException e) {
                    conflict.incrementAndGet();
                } catch (Exception e) {
                    throw new AssertionError("不应出现其他异常: " + e.getMessage(), e);
                }
            });
        }
        assertTrue(ready.await(5, TimeUnit.SECONDS));
        start.countDown();
        pool.shutdown();
        assertTrue(pool.awaitTermination(5, TimeUnit.SECONDS));

        assertEquals(1, success.get(), "恰有一个 run 创建成功");
        assertEquals(threads - 1, conflict.get(), "其余被并发拒绝");
    }

    private AgentCompleteRequest completeRequest(String runId, String status, String workspacePath) {
        AgentCompleteRequest request = new AgentCompleteRequest();
        request.setAppId(1L);
        request.setUserId(1L);
        request.setStatus(status);
        request.setWorkspacePath(workspacePath);
        return request;
    }

    private AgentCompleteRequest.Message message(String type, String content) {
        AgentCompleteRequest.Message message = new AgentCompleteRequest.Message();
        message.setMessageType(type);
        message.setContent(content);
        return message;
    }


    @Test
    void completeRunSuccessWritesHistoryAndBuilds() {
        App app = new App();
        app.setId(1L);
        app.setCodeGenType("html");
        when(appService.getById(1L)).thenReturn(app);

        AgentCompleteRequest request = completeRequest("run-1", "success", "/tmp/ws/html_1");
        request.setMessages(List.of(message("user", "hello"), message("ai", "<html>page</html>")));
        service.completeRun("run-1", request);

        verify(chatHistoryService, times(2)).addChatMessage(eq(1L), anyString(), anyString(), any(User.class));
    }


    @Test
    void completeRunFailedWritesErrorHistory() {
        App app = new App();
        app.setId(1L);
        when(appService.getById(1L)).thenReturn(app);

        AgentCompleteRequest request = completeRequest("run-1", "failed", null);
        request.setErrorMessage("boom");
        request.setErrorCode("model-error");
        service.completeRun("run-1", request);

        verify(chatHistoryService, times(1))
                .addChatMessage(eq(1L), eq("生成失败[model-error]:boom"), eq("ai"), any(User.class));
    }


    @Test
    void completeRunNormalizesUnknownFailureCode() {
        App app = new App();
        app.setId(1L);
        when(appService.getById(1L)).thenReturn(app);

        AgentCompleteRequest request = completeRequest("run-1", "failed", null);
        request.setErrorMessage("boom");
        request.setErrorCode("future-code");
        service.completeRun("run-1", request);

        verify(chatHistoryService).addChatMessage(eq(1L), eq("生成失败[unknown]:boom"), eq("ai"), any(User.class));
    }


    @Test
    void completeRunIdempotentSkipsRepeat() {
        App app = new App();
        app.setId(1L);
        app.setCodeGenType("html");
        when(appService.getById(1L)).thenReturn(app);

        AgentCompleteRequest request = completeRequest("run-1", "success", "/tmp/ws/html_1");
        request.setMessages(List.of(message("ai", "<html>page</html>")));
        service.completeRun("run-1", request);
        service.completeRun("run-1", request);

        verify(chatHistoryService, times(1)).addChatMessage(anyLong(), anyString(), anyString(), any(User.class));
    }


    @Test
    void completeRunRejectsInvalidStatus() {
        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.completeRun("run-1", completeRequest("run-1", "unknown", "/tmp/ws")));
        assertEquals("status 仅接受 success/failed/aborted", ex.getMessage());
    }


    @Test
    void completeRunRejectsMissingWorkspaceOnSuccess() {
        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.completeRun("run-1", completeRequest("run-1", "success", null)));
        assertEquals("workspacePath 不能为空", ex.getMessage());
    }


    @Test
    void completeRunRejectsMissingApp() {
        when(appService.getById(1L)).thenReturn(null);
        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.completeRun("run-1", completeRequest("run-1", "success", "/tmp/ws")));
        assertEquals("应用不存在", ex.getMessage());
    }


    @Test
    void acquireWireframeQuotaSucceeds() {
        when(rateLimiter.tryAcquire(1)).thenReturn(true);
        assertTrue(service.acquireWireframeDailyQuota(1L));
        verify(redissonClient).getRateLimiter("rate_limit:user:1:wireframe_daily");
        verify(rateLimiter).trySetRate(any(), eq(10L), any());
    }


    @Test
    void acquireWireframeQuotaExceededThrows() {
        when(rateLimiter.tryAcquire(1)).thenReturn(false);
        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.acquireWireframeDailyQuota(1L));
        assertEquals("今日线框生成次数已用完，请明天再试", ex.getMessage());
    }


    @Test
    void acquireWireframeQuotaRejectsInvalidUserId() {
        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.acquireWireframeDailyQuota(null));
        assertEquals("userId 不能为空", ex.getMessage());
        verify(redissonClient, never()).getRateLimiter(anyString());
    }



    private GenerationRun terminalRunEntity(String runId, String phase) {
        return run(runId, 1L, phase);
    }


    @Test
    void completeRunSuccessSettlesCreditAndMarksDone() {
        App app = new App();
        app.setId(1L);
        app.setCodeGenType("html");
        when(appService.getById(1L)).thenReturn(app);
        when(mapper.selectOneById("run-1")).thenReturn(terminalRunEntity("run-1", "coding"));

        AgentCompleteRequest request = completeRequest("run-1", "success", "/tmp/ws/html_1");
        request.setMessages(List.of(message("user", "hello"), message("ai", "<html>page</html>")));
        service.completeRun("run-1", request);

        verify(creditService).settleRun("run-1");
        verify(creditService, never()).refundRun(anyString(), any(), any(), any());

        verify(mapper).update(argThat(r -> "done".equals(r.getPhase())
                && "run-1".equals(r.getRunId())), anyBoolean());
    }


    @Test
    void completeRunFailedRefundsAndMarksFailed() {
        App app = new App();
        app.setId(1L);
        when(appService.getById(1L)).thenReturn(app);
        when(mapper.selectOneById("run-1")).thenReturn(terminalRunEntity("run-1", "coding"));

        AgentCompleteRequest request = completeRequest("run-1", "failed", null);
        request.setErrorMessage("boom");
        service.completeRun("run-1", request);

        verify(creditService).refundRun(eq("run-1"), eq(AgentCompleteStatusEnum.FAILED), isNull(), any());
        verify(chatHistoryService, times(1))
                .addChatMessage(eq(1L), eq("生成失败[unknown]:boom"), eq("ai"), any(User.class));
        verify(mapper).update(argThat(r -> "failed".equals(r.getPhase())
                && "run-1".equals(r.getRunId())), anyBoolean());
    }


    @Test
    void completeRunAbortedMarksHistoryAndRefundsPartial() {
        App app = new App();
        app.setId(1L);
        when(appService.getById(1L)).thenReturn(app);
        when(mapper.selectOneById("run-1")).thenReturn(terminalRunEntity("run-1", "coding"));

        AgentCompleteRequest request = completeRequest("run-1", "aborted", null);
        request.setFilesWritten(2);
        request.setMessages(List.of(message("user", "hello"), message("ai", "已保留 2 个文件")));
        service.completeRun("run-1", request);


        verify(chatHistoryService).addChatMessage(eq(1L), eq("[用户中断] 已保留 2 个文件"), eq("ai"), any(User.class));

        verify(creditService).refundRun(eq("run-1"), eq(AgentCompleteStatusEnum.ABORTED), eq(2), isNull());
        verify(creditService, never()).settleRun(anyString());

        verify(mapper).update(argThat(r -> "aborted".equals(r.getPhase())
                && "run-1".equals(r.getRunId())), anyBoolean());
    }


    @Test
    void completeRunAbortedNoFileRefundsFull() {
        App app = new App();
        app.setId(1L);
        when(appService.getById(1L)).thenReturn(app);
        when(mapper.selectOneById("run-1")).thenReturn(terminalRunEntity("run-1", "coding"));

        AgentCompleteRequest request = completeRequest("run-1", "aborted", null);
        request.setFilesWritten(0);
        service.completeRun("run-1", request);

        verify(creditService).refundRun(eq("run-1"), eq(AgentCompleteStatusEnum.ABORTED), eq(0), any());
        verify(creditService, never()).settleRun(anyString());
    }



    private CreditFreezeRequest freezeRequest(String intensity) {
        CreditFreezeRequest request = new CreditFreezeRequest();
        request.setIntensity(intensity);
        return request;
    }


    @Test
    void freezeCreditSucceedsAndLinksLedgerRef() {
        when(mapper.selectOneById("run-1")).thenReturn(run("run-1", 1L, "wireframe_confirmed"));
        CreditFreezeVO vo = new CreditFreezeVO();
        vo.setLedgerId(9L);
        vo.setFrozenAmount(100);
        vo.setBalance(400);
        when(creditService.freeze(eq("run-1"), eq(1L), eq(1L), eq("standard"))).thenReturn(vo);

        CreditFreezeVO result = service.freezeCredit("run-1", freezeRequest("standard"));

        assertEquals(9L, result.getLedgerId());
        verify(mapper).update(argThat(r -> "run-1".equals(r.getRunId()) && "9".equals(r.getCreditLedgerRef())), anyBoolean());
    }


    @Test
    void freezeCreditIdempotentReturnsExisting() {
        GenerationRun already = run("run-1", 1L, "coding");
        already.setCreditLedgerRef("9");
        when(mapper.selectOneById("run-1")).thenReturn(already);
        when(creditService.getByRunId("run-1")).thenReturn(frozenLedgerEntity());
        CreditFreezeVO vo = new CreditFreezeVO();
        vo.setLedgerId(9L);
        vo.setFrozenAmount(100);
        vo.setBalance(300);
        when(creditService.buildFreezeVO(any())).thenReturn(vo);

        CreditFreezeVO result = service.freezeCredit("run-1", freezeRequest("standard"));

        assertEquals(9L, result.getLedgerId());
        assertEquals(300, result.getBalance());
        verify(creditService).buildFreezeVO(frozenLedgerEntity());
        verify(creditService, never()).freeze(anyString(), any(), any(), any());
    }


    @Test
    void freezeCreditRejectsNonConfirmedPhase() {
        when(mapper.selectOneById("run-1")).thenReturn(run("run-1", 1L, "wireframe_pending"));
        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.freezeCredit("run-1", freezeRequest("standard")));
        assertEquals("当前阶段（wireframe_pending）不能冻结积分，请先确认线框", ex.getMessage());
        verify(creditService, never()).freeze(anyString(), any(), any(), any());
    }


    @Test
    void freezeCreditRejectsMissingRun() {
        when(mapper.selectOneById("run-1")).thenReturn(null);
        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.freezeCredit("run-1", freezeRequest("standard")));
        assertEquals("运行不存在", ex.getMessage());
    }


    @Test
    void completeRunAbortedPassesMilestoneCount() {
        App app = new App();
        app.setId(1L);
        when(appService.getById(1L)).thenReturn(app);
        GenerationRun coding = run("run-1", 1L, "coding");
        coding.setMilestones("[\"开始生成\",\"规划页面结构\"]");
        when(mapper.selectOneById("run-1")).thenReturn(coding);

        AgentCompleteRequest request = completeRequest("run-1", "aborted", null);
        request.setFilesWritten(1);
        service.completeRun("run-1", request);

        verify(creditService).refundRun(eq("run-1"), eq(AgentCompleteStatusEnum.ABORTED), eq(1), eq(2));
    }


    @Test
    void completeRunFailedWithEmptyAiMessage_skipsEmptyAndStillRefunds() {
        App app = new App();
        app.setId(1L);
        when(appService.getById(1L)).thenReturn(app);
        when(mapper.selectOneById("run-1")).thenReturn(terminalRunEntity("run-1", "coding"));

        AgentCompleteRequest request = completeRequest("run-1", "failed", null);
        request.setErrorMessage("boom");
        request.setMessages(List.of(message("user", "hello"), message("ai", "")));
        service.completeRun("run-1", request);


        verify(chatHistoryService, times(1)).addChatMessage(eq(1L), eq("hello"), eq("user"), any(User.class));
        verify(chatHistoryService, times(1)).addChatMessage(eq(1L), eq("生成失败[unknown]:boom"), eq("ai"), any(User.class));
        verify(chatHistoryService, times(2)).addChatMessage(anyLong(), anyString(), anyString(), any(User.class));

        verify(creditService).refundRun(eq("run-1"), eq(AgentCompleteStatusEnum.FAILED), isNull(), any());
    }


    @Test
    void completeRunLateSuccessAfterAborted_rejected() {
        App app = new App();
        app.setId(1L);
        when(appService.getById(1L)).thenReturn(app);
        when(mapper.selectOneById("run-1")).thenReturn(terminalRunEntity("run-1", "aborted"));

        AgentCompleteRequest request = completeRequest("run-1", "success", "/tmp/ws/html_1");
        request.setMessages(List.of(message("ai", "<html>page</html>")));
        service.completeRun("run-1", request);

        verify(chatHistoryService, never()).addChatMessage(anyLong(), anyString(), anyString(), any(User.class));
        verify(creditService, never()).settleRun(anyString());
        verify(creditService, never()).refundRun(anyString(), any(), any(), any());

        verify(mapper, never()).update(any(GenerationRun.class), anyBoolean());
    }


    @Test
    void completeRunLedgerAlreadyTerminal_skipsLateCallback() {
        CreditLedger settled = CreditLedger.builder()
                .id(9L)
                .runId("run-1")
                .status(CreditLedgerStatusEnum.SETTLED.getValue())
                .build();
        when(creditService.getByRunId("run-1")).thenReturn(settled);

        AgentCompleteRequest request = completeRequest("run-1", "success", "/tmp/ws/html_1");
        request.setMessages(List.of(message("ai", "<html>page</html>")));
        service.completeRun("run-1", request);

        verify(chatHistoryService, never()).addChatMessage(anyLong(), anyString(), anyString(), any(User.class));
        verify(creditService, never()).settleRun(anyString());
        verify(creditService, never()).refundRun(anyString(), any(), any(), any());
    }

    private CreditLedger frozenLedgerEntity() {
        return CreditLedger.builder()
                .id(9L)
                .runId("run-1")
                .userId(1L)
                .appId(1L)
                .status(CreditLedgerStatusEnum.FROZEN.getValue())
                .frozenAmount(100)
                .build();
    }
}
