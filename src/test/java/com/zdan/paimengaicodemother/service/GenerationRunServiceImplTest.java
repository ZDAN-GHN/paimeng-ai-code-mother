package com.zdan.paimengaicodemother.service;

import com.zdan.paimengaicodemother.ai.agent.AgentProperties;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ConcurrentRunException;
import com.zdan.paimengaicodemother.mapper.GenerationRunMapper;
import com.zdan.paimengaicodemother.model.dto.run.AgentCompleteRequest;
import com.zdan.paimengaicodemother.model.dto.run.CreditFreezeRequest;
import com.zdan.paimengaicodemother.model.dto.run.RunCreateRequest;
import com.zdan.paimengaicodemother.model.dto.run.RunUpdateRequest;
import com.zdan.paimengaicodemother.model.entity.App;
import com.zdan.paimengaicodemother.model.entity.CreditLedger;
import com.zdan.paimengaicodemother.model.entity.GenerationRun;
import com.zdan.paimengaicodemother.model.entity.User;
import com.zdan.paimengaicodemother.model.enums.AgentCompleteStatusEnum;
import com.zdan.paimengaicodemother.model.enums.CreditLedgerStatusEnum;
import com.zdan.paimengaicodemother.model.vo.CreditFreezeVO;
import com.zdan.paimengaicodemother.model.vo.RunVO;
import com.zdan.paimengaicodemother.service.impl.GenerationRunServiceImpl;
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

/**
 * GenerationRunServiceImpl 单元测试（Mockito mock mapper，不依赖 Spring 上下文）
 * 覆盖：创建/幂等创建/并发拒绝/幂等更新/最新非终态查询/参数与 JSON 校验/线框每日配额
 *
 * @author LXH
 */
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

    /**
     * 创建成功：插入并返回完整 VO
     */
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

    /**
     * 幂等：同 runId 重复创建返回既有 run，不重复插入
     */
    @Test
    void createRunIdempotentReturnsExisting() {
        when(mapper.selectOneById("run-dup")).thenReturn(run("run-dup", 1L, "coding"));

        RunVO vo = service.createRun(createRequest("run-dup", 1L, "interview"));

        assertNotNull(vo);
        assertEquals("coding", vo.getPhase());
        verify(mapper, never()).insert(any(GenerationRun.class));
    }

    /**
     * 并发：同 app 已有非终态 run → 409 文案的 ConcurrentRunException
     */
    @Test
    void createRunRejectsConcurrentActiveRun() {
        when(mapper.selectOneById("run-2")).thenReturn(null);
        when(mapper.selectListByQuery(any())).thenReturn(List.of(run("run-1", 1L, "coding")));

        ConcurrentRunException ex = assertThrows(ConcurrentRunException.class,
                () -> service.createRun(createRequest("run-2", 1L, "interview")));
        assertEquals("当前有进行中的任务", ex.getMessage());
        verify(mapper, never()).insert(any(GenerationRun.class));
    }

    /**
     * 既有 run 为终态时允许新建（查询层按 SQL notIn 已过滤终态，mock 模拟过滤结果为空）
     */
    @Test
    void createRunAllowsAfterTerminalRun() {
        when(mapper.selectOneById("run-2")).thenReturn(null);
        when(mapper.selectListByQuery(any())).thenReturn(List.of());
        when(mapper.insert(any(GenerationRun.class), anyBoolean())).thenReturn(1);

        RunVO vo = service.createRun(createRequest("run-2", 1L, "interview"));

        assertNotNull(vo);
        verify(mapper, times(1)).insert(any(GenerationRun.class), anyBoolean());
    }

    /**
     * 非法 phase 拒绝
     */
    @Test
    void createRunRejectsInvalidPhase() {
        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.createRun(createRequest("run-x", 1L, "not-a-phase")));
        assertEquals("phase 非法", ex.getMessage());
    }

    /**
     * context 非合法 JSON 拒绝
     */
    @Test
    void createRunRejectsInvalidJsonContext() {
        RunCreateRequest request = createRequest("run-x", 1L, "interview");
        request.setContext("not json");
        BusinessException ex = assertThrows(BusinessException.class, () -> service.createRun(request));
        assertEquals("context 必须是合法 JSON", ex.getMessage());
    }

    /**
     * 幂等更新：无字段变化时不落库（updateTime 不刷新）
     */
    @Test
    void updateRunIdempotentSkipsWhenUnchanged() {
        when(mapper.selectOneById("run-1")).thenReturn(run("run-1", 1L, "coding"));
        RunUpdateRequest request = new RunUpdateRequest();
        request.setPhase("coding");

        RunVO vo = service.updateRun("run-1", request);

        assertEquals("coding", vo.getPhase());
        verify(mapper, never()).update(any(GenerationRun.class));
    }

    /**
     * 更新变化字段并落库；进入终态自动补 finishedTime
     */
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

    /**
     * 更新不存在的 run → 404 语义（NOT_FOUND_ERROR）
     */
    @Test
    void updateRunNotFoundThrows() {
        when(mapper.selectOneById("nope")).thenReturn(null);
        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.updateRun("nope", new RunUpdateRequest()));
        assertEquals("运行不存在", ex.getMessage());
    }

    /**
     * 最新非终态 run：无 → null
     */
    @Test
    void getLatestNonTerminalRunReturnsNullWhenNone() {
        when(mapper.selectListByQuery(any())).thenReturn(List.of());
        assertNull(service.getLatestNonTerminalRun(1L, null));
    }

    /**
     * 最新非终态 run：返回最新一条（按创建时间倒序由查询保证）
     */
    @Test
    void getLatestNonTerminalRunReturnsRun() {
        when(mapper.selectListByQuery(any())).thenReturn(List.of(run("run-1", 1L, "wireframe_pending")));
        RunVO vo = service.getLatestNonTerminalRun(1L, null);
        assertNotNull(vo);
        assertEquals("run-1", vo.getRunId());
    }

    /**
     * 并发安全：同 app 两个 run 同时创建，恰好一个成功一个被拒（app 级锁串行化）
     */
    @Test
    void createRunConcurrentUnderThreadsExactlyOneSucceeds() throws Exception {
        // 共享「活跃 run」列表：模拟已落库数据；插入时追加（原子）
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

    /**
     * 成功回调：写 user/ai 历史并按 app 的 codeGenType 触发构建
     */
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

    /**
     * 失败回调：写一条错误历史（AI 类型），不触发构建
     */
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

    /**
     * 非法稳定失败代码归一为 unknown，避免跨服务调用方注入未冻结的分流值
     */
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

    /**
     * 非法 status 拒绝
     */
    @Test
    void completeRunRejectsInvalidStatus() {
        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.completeRun("run-1", completeRequest("run-1", "unknown", "/tmp/ws")));
        assertEquals("status 仅接受 success/failed/aborted", ex.getMessage());
    }

    /**
     * success 缺少 workspacePath 拒绝
     */
    @Test
    void completeRunRejectsMissingWorkspaceOnSuccess() {
        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.completeRun("run-1", completeRequest("run-1", "success", null)));
        assertEquals("workspacePath 不能为空", ex.getMessage());
    }

    /**
     * 应用不存在 → NOT_FOUND
     */
    @Test
    void completeRunRejectsMissingApp() {
        when(appService.getById(1L)).thenReturn(null);
        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.completeRun("run-1", completeRequest("run-1", "success", "/tmp/ws")));
        assertEquals("应用不存在", ex.getMessage());
    }

    /**
     * 配额获取成功：acquire 返回 true
     */
    @Test
    void acquireWireframeQuotaSucceeds() {
        when(rateLimiter.tryAcquire(1)).thenReturn(true);
        assertTrue(service.acquireWireframeDailyQuota(1L));
        verify(redissonClient).getRateLimiter("rate_limit:user:1:wireframe_daily");
        verify(rateLimiter).trySetRate(any(), eq(10L), any());
    }

    /**
     * 配额耗尽 → TOO_MANY_REQUEST 明确文案
     */
    @Test
    void acquireWireframeQuotaExceededThrows() {
        when(rateLimiter.tryAcquire(1)).thenReturn(false);
        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.acquireWireframeDailyQuota(1L));
        assertEquals("今日线框生成次数已用完，请明天再试", ex.getMessage());
    }

    /**
     * 非正 userId → PARAMS_ERROR
     */
    @Test
    void acquireWireframeQuotaRejectsInvalidUserId() {
        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.acquireWireframeDailyQuota(null));
        assertEquals("userId 不能为空", ex.getMessage());
        verify(redissonClient, never()).getRateLimiter(anyString());
    }

    // ── #10 积分：completeRun 三剧本记账 + run 终态一致 ──

    private GenerationRun terminalRunEntity(String runId, String phase) {
        return run(runId, 1L, phase);
    }

    /**
     * 成功回调：结算积分（FROZEN → SETTLED）+ run 推进 done 终态
     */
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
        // run 终态与台账一致：success → done
        verify(mapper).update(argThat(r -> "done".equals(r.getPhase())
                && "run-1".equals(r.getRunId())), anyBoolean());
    }

    /**
     * 失败回调：全额退款 + 写错误历史 + run 推进 failed 终态
     */
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

    /**
     * 中断回调：历史 ai 消息带 [用户中断] 标记 + 按已写文件数折算退款 + run 推进 aborted 终态
     */
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

        // 历史 ai 消息带 [用户中断] 标记（验收）
        verify(chatHistoryService).addChatMessage(eq(1L), eq("[用户中断] 已保留 2 个文件"), eq("ai"), any(User.class));
        // 中断折算退款（filesWritten=2，里程碑从 run.milestones 解析，未 stub → milestoneCount null → 基础比例）
        verify(creditService).refundRun(eq("run-1"), eq(AgentCompleteStatusEnum.ABORTED), eq(2), isNull());
        verify(creditService, never()).settleRun(anyString());
        // run 终态与台账一致：aborted
        verify(mapper).update(argThat(r -> "aborted".equals(r.getPhase())
                && "run-1".equals(r.getRunId())), anyBoolean());
    }

    /**
     * 中断回调首文件落盘前（filesWritten=0）：全额退款路径（台账 REFUNDED，Java 侧折算）
     */
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

    // ── #10 积分：冻结 ──

    private CreditFreezeRequest freezeRequest(String intensity) {
        CreditFreezeRequest request = new CreditFreezeRequest();
        request.setIntensity(intensity);
        return request;
    }

    /**
     * 冻结成功：wireframe_confirmed 阶段扣款 + 台账关联写回 run.creditLedgerRef
     */
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

    /**
     * 冻结幂等：creditLedgerRef 已关联（同 run 已冻结过）→ 直接返回既有台账，不重复扣款
     */
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

    /**
     * 冻结前置：非 wireframe_confirmed 阶段拒绝（线框闸门经济学，冻结时点=进入 codegen）
     */
    @Test
    void freezeCreditRejectsNonConfirmedPhase() {
        when(mapper.selectOneById("run-1")).thenReturn(run("run-1", 1L, "wireframe_pending"));
        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.freezeCredit("run-1", freezeRequest("standard")));
        assertEquals("当前阶段（wireframe_pending）不能冻结积分，请先确认线框", ex.getMessage());
        verify(creditService, never()).freeze(anyString(), any(), any(), any());
    }

    /**
     * 冻结：run 不存在 → NOT_FOUND
     */
    @Test
    void freezeCreditRejectsMissingRun() {
        when(mapper.selectOneById("run-1")).thenReturn(null);
        BusinessException ex = assertThrows(BusinessException.class,
                () -> service.freezeCredit("run-1", freezeRequest("standard")));
        assertEquals("运行不存在", ex.getMessage());
    }

    /**
     * 中断回调的里程碑数：从 run.milestones JSON 解析后传给退款折算
     */
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

    /**
     * failed 回调的 ai 消息为空：跳过空消息（不抛「消息不能为空」），退款仍执行（e2e 实测根因）
     */
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

        // 空 ai 跳过，只写 user + Java 错误历史
        verify(chatHistoryService, times(1)).addChatMessage(eq(1L), eq("hello"), eq("user"), any(User.class));
        verify(chatHistoryService, times(1)).addChatMessage(eq(1L), eq("生成失败[unknown]:boom"), eq("ai"), any(User.class));
        verify(chatHistoryService, times(2)).addChatMessage(anyLong(), anyString(), anyString(), any(User.class));
        // 退款不被空消息阻断
        verify(creditService).refundRun(eq("run-1"), eq(AgentCompleteStatusEnum.FAILED), isNull(), any());
    }

    /**
     * 迟到错序回调（AC5）：run 已终态（aborted）却收到 success 回调 → 拒绝处理，
     * 不写历史、不结算、不改变 run 状态（防 run 终态与台账状态错乱）
     */
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
        // run 保持 aborted，不推进 done
        verify(mapper, never()).update(any(GenerationRun.class), anyBoolean());
    }

    /**
     * 迟到重复回调（AC5/AC4，进程重启丢内存集场景）：台账已终态（SETTLED）→ 幂等跳过，
     * 不再写历史/结算（台账终态是比内存集合更可靠的记账完成标记）
     */
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
