package com.zdan.paimengaicodemother.ai.python;

import com.zdan.paimengaicodemother.ai.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodemother.core.handler.JsonMessageStreamHandler;
import com.zdan.paimengaicodemother.core.handler.SimpleTextStreamHandler;
import com.zdan.paimengaicodemother.service.ChatHistoryService;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Flux;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 事件分流适配测试（T15）
 * 验证：error 事件不进入展示流；data 为 null 的空事件（Reactor 解码产物）被过滤；
 * vue_project → JsonMessageStreamHandler，html/multi_file → SimpleTextStreamHandler
 *
 * @author LXH
 */
class PythonAgentSseAdapterTest {

    /**
     * 空 data 事件（Reactor 解码流中产生的空事件）被过滤，不导致 mapper null
     */
    @Test
    void nullDataEventsAreFiltered() {
        SimpleTextStreamHandler simpleText = mock(SimpleTextStreamHandler.class);
        JsonMessageStreamHandler jsonHandler = mock(JsonMessageStreamHandler.class);
        // handler 透传数据流，便于断言 adapter 过滤后的内容
        when(simpleText.handle(any(), any(), anyLong(), any())).thenAnswer(inv -> inv.getArgument(0));
        PythonAgentSseAdapter adapter = new PythonAgentSseAdapter(jsonHandler, simpleText);

        Flux<PythonAgentClient.SseEvent> input = Flux.just(
                new PythonAgentClient.SseEvent(null, null),
                new PythonAgentClient.SseEvent("error", "{\"message\":\"boom\"}"),
                new PythonAgentClient.SseEvent(null, "正常文本"),
                new PythonAgentClient.SseEvent(null, null),
                new PythonAgentClient.SseEvent(null, "后续文本")
        );
        List<String> output = adapter.adapt(input, CodeGenTypeEnum.HTML, mock(ChatHistoryService.class), 1L, null)
                .collectList().block();
        assertEquals(List.of("正常文本", "后续文本"), output);
    }

    /**
     * error 事件不进入业务展示流
     */
    @Test
    void errorEventsAreFiltered() {
        SimpleTextStreamHandler simpleText = mock(SimpleTextStreamHandler.class);
        JsonMessageStreamHandler jsonHandler = mock(JsonMessageStreamHandler.class);
        when(simpleText.handle(any(), any(), anyLong(), any())).thenAnswer(inv -> inv.getArgument(0));
        PythonAgentSseAdapter adapter = new PythonAgentSseAdapter(jsonHandler, simpleText);

        Flux<PythonAgentClient.SseEvent> input = Flux.just(
                new PythonAgentClient.SseEvent("error", "{\"message\":\"拒绝\"}"),
                new PythonAgentClient.SseEvent(null, "ai 文本")
        );
        List<String> output = adapter.adapt(input, CodeGenTypeEnum.HTML, mock(ChatHistoryService.class), 1L, null)
                .collectList().block();
        assertEquals(List.of("ai 文本"), output);
    }

    /**
     * vue_project 路由到 JsonMessageStreamHandler
     */
    @Test
    void vueRoutesToJsonHandler() {
        SimpleTextStreamHandler simpleText = mock(SimpleTextStreamHandler.class);
        JsonMessageStreamHandler jsonHandler = mock(JsonMessageStreamHandler.class);
        when(jsonHandler.handle(any(), any(), anyLong(), any())).thenAnswer(inv -> inv.getArgument(0));
        PythonAgentSseAdapter adapter = new PythonAgentSseAdapter(jsonHandler, simpleText);

        Flux<PythonAgentClient.SseEvent> input = Flux.just(
                new PythonAgentClient.SseEvent(null, "{\"type\":\"ai_response\",\"data\":\"ok\"}")
        );
        List<String> output = adapter.adapt(input, CodeGenTypeEnum.VUE_PROJECT, mock(ChatHistoryService.class), 1L, null)
                .collectList().block();
        assertEquals(List.of("{\"type\":\"ai_response\",\"data\":\"ok\"}"), output);
    }
}
