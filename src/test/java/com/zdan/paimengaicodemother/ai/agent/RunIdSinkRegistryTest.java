package com.zdan.paimengaicodemother.ai.agent;

import com.zdan.paimengaicodemother.ai.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodemother.model.entity.User;
import org.junit.jupiter.api.Test;
import org.springframework.http.codec.ServerSentEvent;

import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/**
 * RunIdSinkRegistry 单元测试（不依赖 Spring 上下文）
 * 验证 runId 幂等、终端信号（done / business-error）与超时兜底
 *
 * @author LXH
 */
class RunIdSinkRegistryTest {

    private RunIdSinkRegistry registry() {
        return new RunIdSinkRegistry();
    }

    private User user() {
        User user = new User();
        user.setId(10001L);
        return user;
    }

    private RunIdSinkRegistry.Entry register(RunIdSinkRegistry registry, String runId) {
        return registry.register(runId, 1L, CodeGenTypeEnum.HTML, "/tmp/ws/html_1", user());
    }

    /**
     * 幂等：tryMarkProcessed 仅首次返回 true
     */
    @Test
    void tryMarkProcessedIsIdempotent() {
        RunIdSinkRegistry registry = registry();
        String runId = "run-1";
        register(registry, runId);
        assertTrue(registry.tryMarkProcessed(runId));
        assertFalse(registry.tryMarkProcessed(runId));
        assertFalse(registry.tryMarkProcessed(runId));
    }

    /**
     * 不存在的 runId：tryMarkProcessed 返回 false（丢弃迟到回调）
     */
    @Test
    void tryMarkProcessedMissingReturnsFalse() {
        RunIdSinkRegistry registry = registry();
        assertFalse(registry.tryMarkProcessed("nope"));
    }

    /**
     * complete 发送终端信号并移除条目
     */
    @Test
    void completeEmitsTerminalAndRemovesEntry() {
        RunIdSinkRegistry registry = registry();
        String runId = "run-2";
        register(registry, runId);
        assertTrue(registry.get(runId).isPresent());

        ServerSentEvent<String> done = ServerSentEvent.<String>builder().event("done").build();
        registry.complete(runId, done);

        assertTrue(registry.get(runId).isEmpty());
        // 已移除的条目：再次 complete 是 no-op
        registry.complete(runId, done);
    }

    /**
     * awaitTerminal 收到回调信号后完成；超时走兜底信号
     */
    @Test
    void awaitTerminalTimeoutFallsBack() {
        RunIdSinkRegistry registry = registry();
        String runId = "run-3";
        register(registry, runId);
        AtomicInteger fallbackCount = new AtomicInteger();

        ServerSentEvent<String> fallback = ServerSentEvent.<String>builder()
                .event("business-error")
                .data("{\"error\":true,\"message\":\"生成超时\"}")
                .build();
        // 超时时间设为 0，立刻触发兜底
        ServerSentEvent<String> result = registry.awaitTerminal(runId, 0, () -> {
            fallbackCount.incrementAndGet();
            return fallback;
        }).block();

        assertNotNull(result);
        assertEquals("business-error", result.event());
        assertEquals(1, fallbackCount.get());
    }

    /**
     * awaitTerminal 在回调 complete 后立即返回 done（不触发超时）
     */
    @Test
    void awaitTerminalCompletesWithCallback() {
        RunIdSinkRegistry registry = registry();
        String runId = "run-4";
        register(registry, runId);

        // 先装配 terminal（捕获条目引用，与运行时流程一致），再触发回调 complete
        ServerSentEvent<String> done = ServerSentEvent.<String>builder().event("done").build();
        var mono = registry.awaitTerminal(runId, 5000, () -> {
            throw new AssertionError("不应触发超时兜底");
        });
        registry.complete(runId, done);

        ServerSentEvent<String> result = mono.block();
        assertNotNull(result);
        assertEquals("done", result.event());
    }

    /**
     * 条目移除后 awaitTerminal 返回空（无等待对象）
     */
    @Test
    void awaitTerminalMissingReturnsEmpty() {
        RunIdSinkRegistry registry = registry();
        assertNull(registry.awaitTerminal("nope", 5000, () -> null).block());
    }
}
