package com.zdan.paimengaicodebackend.platform.domain;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * Owner 状态流的连接登记（Issue #80 / T-08）
 *
 * <p>这里只做「谁在听」和「变了」的信号，不缓存任何状态内容：订阅方拿到的是一个
 * 投影回调，每次变化都重新读取权威投影再推送。这样 SSE 通道不可能成为第二个状态
 * 来源，也就不会出现两套真相。真正的 {@code SseEmitter} 写入留在 Controller，
 * 便于用投影层的异常映射统一处理失效连接。
 *
 * <p>单进程内存实现。权威状态在数据库里，多实例部署时每个实例只通知自己持有的连接，
 * 客户端断线重连后会从投影读到最新值——MVP 阶段不引入外部消息中间件。
 */
@Component
public class PlatformStatusStreamRegistry {

    private static final Logger log = LoggerFactory.getLogger(PlatformStatusStreamRegistry.class);

    /** 30 分钟后强制回收，客户端随后重连并读取最新投影。 */
    private static final long STREAM_TIMEOUT_MILLIS = 30 * 60 * 1000L;

    private final Map<Long, Map<String, Subscription>> subscriptions = new ConcurrentHashMap<>();

    /**
     * 登记一条状态流连接，并立即推送一次当前投影。
     *
     * @param projector 每次状态可能变化时重新读取并推送权威投影的回调
     * @return 交由容器托管的 emitter；生命周期与超时由本注册表回收
     */
    public SseEmitter subscribe(long applicationId, String connectionId, Consumer<SseEmitter> projector) {
        SseEmitter emitter = new SseEmitter(STREAM_TIMEOUT_MILLIS);
        Map<String, Subscription> connections =
            subscriptions.computeIfAbsent(applicationId, key -> new ConcurrentHashMap<>());
        connections.put(connectionId, new Subscription(emitter, projector));
        emitter.onCompletion(() -> remove(applicationId, connectionId));
        emitter.onTimeout(() -> {
            remove(applicationId, connectionId);
            emitter.complete();
        });
        emitter.onError(ignored -> remove(applicationId, connectionId));
        try {
            projector.accept(emitter);
        } catch (RuntimeException initialFailure) {
            remove(applicationId, connectionId);
            emitter.completeWithError(initialFailure);
        }
        return emitter;
    }

    /** 状态可能已变化。推送失败只断开该连接，客户端重连即可读到最新投影。 */
    public void notifyChanged(long applicationId) {
        Map<String, Subscription> connections = subscriptions.get(applicationId);
        if (connections == null || connections.isEmpty()) {
            return;
        }
        for (Map.Entry<String, Subscription> connection : connections.entrySet()) {
            try {
                connection.getValue().projector().accept(connection.getValue().emitter());
            } catch (RuntimeException projectionFailure) {
                // 连接断开与投影读取失败对这里没有区别：断开该连接，客户端重连后读到最新投影。
                remove(applicationId, connection.getKey());
                log.debug("Owner status connection closed, applicationId: {}, connectionId: {}, cause: {}",
                    applicationId, connection.getKey(), projectionFailure.toString());
            }
        }
    }

    public int activeConnections(long applicationId) {
        Map<String, Subscription> connections = subscriptions.get(applicationId);
        return connections == null ? 0 : connections.size();
    }

    private void remove(long applicationId, String connectionId) {
        Map<String, Subscription> connections = subscriptions.get(applicationId);
        if (connections == null) {
            return;
        }
        connections.remove(connectionId);
        if (connections.isEmpty()) {
            subscriptions.remove(applicationId, connections);
        }
    }

    private record Subscription(SseEmitter emitter, Consumer<SseEmitter> projector) { }
}
