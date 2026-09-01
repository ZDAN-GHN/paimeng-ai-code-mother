"""SSE 流式输出适配（T12）：把生成结果映射为 §1.3 事件并经主通道 SSE 返回。

职责（§1.6）：Python 发出四类语义事件与文本块；Java 复用现有 handler 做展示重组。
- vue_project：结构化 StreamMessage JSON（ai_response/ai_thinking/tool_request/tool_executed）。
- html/multi_file：纯文本增量块（不套 JSON）。
- guardrail 拒绝或生成失败：`event: error` + `data: {"message":"..."}`（§1.3），Java 映射为 business-error。
- 完成回调（T13）：工作区落盘成功后调 success；失败调 failed + message（§1.4，唯一完成信号）。
"""

import json
import logging
from collections.abc import AsyncIterator, Callable

from app.api.callback import CallbackStatus, send_request_callback
from app.api.sse import encode_stream_message, format_data, format_event
from app.core.guardrails import PromptSafetyInputGuardrail
from app.models.schemas import (
    AgentRequest,
    AiResponseMessage,
    AiThinkingMessage,
    StreamMessage,
    ToolExecutedMessage,
    ToolRequestMessage,
)
from app.services.codegen import CodeGenServiceExecutor
from app.tools.file_tools import FileTools
from app.workspace.manager import validate_workspace_path, write_generated_code

logger = logging.getLogger(__name__)


def _normalize_vue_event(item: dict) -> StreamMessage:
    """把 vue 事件 dict 归一化为 §1.3 StreamMessage 模型（字段逐一对齐）。"""
    event_type = item.get("type")
    if event_type == "ai_response":
        return AiResponseMessage(data=str(item.get("data", "")))
    if event_type == "ai_thinking":
        return AiThinkingMessage(text=str(item.get("text", "")))
    if event_type == "tool_request":
        return ToolRequestMessage(
            id=str(item["id"]), name=str(item["name"]), arguments=str(item.get("arguments", ""))
        )
    if event_type == "tool_executed":
        return ToolExecutedMessage(
            id=str(item["id"]),
            name=str(item["name"]),
            arguments=str(item.get("arguments", "")),
            result=str(item.get("result", "")),
        )
    raise ValueError(f"未知的 vue 事件类型: {event_type}")


def _error_event(message: str) -> str:
    """构造错误事件（event: error + data: {"message":...}）。"""
    return format_event("error", json.dumps({"message": message}, ensure_ascii=False))


async def stream_events(
    request: AgentRequest,
    *,
    executor: CodeGenServiceExecutor | None = None,
    guardrail: PromptSafetyInputGuardrail | None = None,
    callback: Callable[..., bool] | None = None,
) -> AsyncIterator[str]:
    """驱动代码生成并产出 SSE 事件流（§1.3），完成后按 §1.4 发回调。

    :param request: 主通道请求（§1.2）
    :param executor: 代码生成执行器（测试可注入）
    :param guardrail: 输入护轨（测试可注入）
    :param callback: 完成回调函数（测试可注入），默认 send_request_callback
    :return: SSE 文本流
    """
    callback = callback or send_request_callback
    guardrail = guardrail or PromptSafetyInputGuardrail()

    # 1. 输入护轨：拒绝则发 error 事件并终止（不再发业务事件）
    guardrail_result = guardrail.validate(request.message)
    if not guardrail_result.is_allowed:
        yield _error_event(guardrail_result.reason)
        _fire_callback(callback, request, "failed", message=guardrail_result.reason)
        return

    executor = executor or CodeGenServiceExecutor()
    code_gen_type = request.codeGenType
    # vue_project 需要绑定工作区的文件工具（工具直接建项目）
    file_tools = (
        FileTools(str(validate_workspace_path(request.workspacePath)))
        if code_gen_type == "vue_project"
        else None
    )
    text_parts: list[str] = []

    try:
        for item in executor.stream(code_gen_type, request.message, file_tools):
            if code_gen_type == "vue_project":
                # 结构化事件：逐字段归一化后编码为 SSE data
                yield encode_stream_message(_normalize_vue_event(item))
            else:
                # 纯文本增量块：按换行拆分 data: 行
                text = str(item)
                yield format_data(text)
                text_parts.append(text)

        # 2. html/multi_file：文本收集完整后解析并原子落盘工作区（§1.5）
        if code_gen_type in ("html", "multi_file") and text_parts:
            write_generated_code(request.workspacePath, code_gen_type, "".join(text_parts))

        # 3. 完成回调（success）：工作区已落盘，通知 Java 继续构建（§1.4）
        _fire_callback(callback, request, "success")
    except Exception as exc:  # noqa: BLE001 - 生成异常转 error 事件 + failed 回调
        logger.exception("代码生成失败: %s", exc)
        yield _error_event(str(exc))
        _fire_callback(callback, request, "failed", message=str(exc))


def _fire_callback(
    callback: Callable[..., bool],
    request: AgentRequest,
    status: CallbackStatus,
    *,
    message: str = "",
) -> None:
    """触发完成回调并记录失败日志（回调自身不阻断主流程）。"""
    try:
        callback(request=request, status=status, message=message)
    except Exception as exc:  # noqa: BLE001 - 回调异常不影响 SSE 流
        logger.error("完成回调触发失败: %s", exc)
