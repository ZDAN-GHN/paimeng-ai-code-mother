package com.zdan.paimengaicodemother.service;

import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ConcurrentRunException;
import com.zdan.paimengaicodemother.mapper.GenerationRunMapper;
import com.zdan.paimengaicodemother.model.dto.run.RunCreateRequest;
import com.zdan.paimengaicodemother.model.dto.run.RunUpdateRequest;
import com.zdan.paimengaicodemother.model.entity.GenerationRun;
import com.zdan.paimengaicodemother.model.vo.RunVO;
import com.zdan.paimengaicodemother.service.impl.GenerationRunServiceImpl;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
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
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.*;

/**
 * GenerationRunServiceImpl 单元测试（Mockito mock mapper，不依赖 Spring 上下文）
 * 覆盖：创建/幂等创建/并发拒绝/幂等更新/最新非终态查询/参数与 JSON 校验
 *
 * @author LXH
 */
class GenerationRunServiceImplTest {

    private GenerationRunMapper mapper;
    private GenerationRunServiceImpl service;

    @BeforeEach
    void setUp() {
        mapper = mock(GenerationRunMapper.class);
        service = new GenerationRunServiceImpl();
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
}
