package com.zdan.paimengaicodemother.ai.python;

import com.zdan.paimengaicodemother.ai.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodemother.model.entity.User;
import lombok.Getter;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;
import reactor.core.publisher.Sinks;

import java.time.Duration;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;

/**
 * runId ↔ 浏览器连接关联注册表（§1.4 A3）
 * 以 runId 为 key 维护浏览器 SSE 终端信号（done / business-error）与请求元数据；
 * 回调到达 / 回调超时通过 terminal 信号通知主通道浏览器连接
 *
 * @author LXH
 */
@Slf4j
@Component
public class RunIdSinkRegistry {

    /**
     * runId -> 请求条目
     */
    private final ConcurrentHashMap<String, Entry> registry = new ConcurrentHashMap<>();

    /**
     * 注册一次生成请求
     *
     * @param runId         本次生成的 runId
     * @param appId         应用 id
     * @param codeGenType   代码生成类型
     * @param workspacePath 工作区绝对路径（回调构建用）
     * @param loginUser     当前登录用户（写历史用）
     * @return 注册条目
     */
    public Entry register(String runId, Long appId, CodeGenTypeEnum codeGenType, String workspacePath, User loginUser) {
        Entry entry = new Entry(runId, appId, codeGenType, workspacePath, loginUser);
        registry.put(runId, entry);
        return entry;
    }

    /**
     * 获取条目（可能已被移除）
     *
     * @param runId runId
     * @return 条目
     */
    public Optional<Entry> get(String runId) {
        return Optional.ofNullable(registry.get(runId));
    }

    /**
     * 幂等标记：仅第一次调用返回 true（回调 / 超时 / 错误事件竞争时保证只处理一次）
     *
     * @param runId runId
     * @return 是否本次首次处理
     */
    public boolean tryMarkProcessed(String runId) {
        Entry entry = registry.get(runId);
        return entry != null && entry.processed.compareAndSet(false, true);
    }

    /**
     * 完成条目：向浏览器连接发送终端信号并移除条目
     *
     * @param runId runId
     * @param sse   终端事件（done / business-error）
     */
    public void complete(String runId, ServerSentEvent<String> sse) {
        Entry entry = registry.remove(runId);
        if (entry != null) {
            entry.terminal.tryEmitValue(sse);
        }
    }

    /**
     * 等待终端信号（回调到达），超时用兜底信号
     *
     * @param runId        runId
     * @param timeoutMs    回调等待超时（callback-timeout-ms）
     * @param fallback    超时兜底信号提供者
     * @return 终端信号（done 或 business-error）
     */
    public Mono<ServerSentEvent<String>> awaitTerminal(String runId, long timeoutMs,
                                                       Supplier<ServerSentEvent<String>> fallback) {
        Entry entry = registry.get(runId);
        if (entry == null) {
            return Mono.empty();
        }
        return entry.terminal.asMono()
                .timeout(Duration.ofMillis(timeoutMs), Mono.defer(() -> {
                    log.warn("回调等待超时，runId: {}", runId);
                    return Mono.just(fallback.get());
                }));
    }

    /**
     * 请求条目
     *
     * @author LXH
     */
    @Getter
    public static class Entry {

        private final String runId;
        private final Long appId;
        private final CodeGenTypeEnum codeGenType;
        private final String workspacePath;
        private final User loginUser;
        private final AtomicBoolean processed = new AtomicBoolean(false);
        private final Sinks.One<ServerSentEvent<String>> terminal = Sinks.one();

        private Entry(String runId, Long appId, CodeGenTypeEnum codeGenType, String workspacePath, User loginUser) {
            this.runId = runId;
            this.appId = appId;
            this.codeGenType = codeGenType;
            this.workspacePath = workspacePath;
            this.loginUser = loginUser;
        }
    }
}
