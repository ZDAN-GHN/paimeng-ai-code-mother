"""主通道 /v1/agent/stream 接口（§1.2-§1.3）。"""

from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from app.auth import require_bearer_token
from app.models import AgentRequest, AiResponseMessage
from app.sse import encode_stream_message, format_data
from app.workspace import validate_workspace_path

router = APIRouter(prefix="/v1/agent")


async def _placeholder_events(request: AgentRequest) -> AsyncIterator[str]:
    """骨架占位事件流（T11 接入 LangGraph 工作流后替换）。

    vue_project 发结构化 StreamMessage JSON，html/multi_file 发纯文本块（§1.3）。
    """
    if request.codeGenType == "vue_project":
        yield encode_stream_message(AiResponseMessage(data="Python Agent 骨架就绪，工作流接入见 T11\n"))
    else:
        yield format_data("Python Agent 骨架就绪，工作流接入见 T11\n")


@router.post("/stream")
async def stream(request: AgentRequest, _token: str = Depends(require_bearer_token)) -> StreamingResponse:
    """主通道：接收生成请求并以 SSE 流返回语义事件。"""
    # §1.2 工作区沙箱校验：workspacePath 必须位于 WORKSPACE_ROOT 之下，否则 400
    try:
        validate_workspace_path(request.workspacePath)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    return StreamingResponse(
        _placeholder_events(request),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
