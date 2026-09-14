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

    event_type = item.get("type")
    if event_type == "ai_response":
        return AiResponseMessage(data=str(item.get("data", "")))
    if event_type == "ai_thinking":
        return AiThinkingMessage(text=str(item.get("text", "")))
    if event_type == "tool_request":
        return ToolRequestMessage(
            id=str(item["id"]),
            name=str(item["name"]),
            arguments=str(item.get("arguments", "")),
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

    return format_event("error", json.dumps({"message": message}, ensure_ascii=False))


async def stream_events(
    request: AgentRequest,
    *,
    executor: CodeGenServiceExecutor | None = None,
    guardrail: PromptSafetyInputGuardrail | None = None,
    callback: Callable[..., bool] | None = None,
) -> AsyncIterator[str]:

    callback = callback or send_request_callback
    guardrail = guardrail or PromptSafetyInputGuardrail()
    guardrail_result = guardrail.validate(request.message)
    if not guardrail_result.is_allowed:
        yield _error_event(guardrail_result.reason)
        _fire_callback(callback, request, "failed", message=guardrail_result.reason)
        return

    executor = executor or CodeGenServiceExecutor()
    code_gen_type = request.codeGenType
    file_tools = (
        FileTools(str(validate_workspace_path(request.workspacePath)))
        if code_gen_type == "vue_project"
        else None
    )
    text_parts: list[str] = []
    try:
        for item in executor.stream(code_gen_type, request.message, file_tools):
            if code_gen_type == "vue_project":
                yield encode_stream_message(_normalize_vue_event(item))
            else:
                text = str(item)
                yield format_data(text)
                text_parts.append(text)

        if code_gen_type in ("html", "multi_file") and text_parts:
            write_generated_code(
                request.workspacePath, code_gen_type, "".join(text_parts)
            )
        _fire_callback(callback, request, "success")
    except Exception as exc:  # noqa: BLE001
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

    try:
        callback(request=request, status=status, message=message)
    except Exception as exc:  # noqa: BLE001
        logger.error("完成回调触发失败: %s", exc)
