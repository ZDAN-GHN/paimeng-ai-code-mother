"""主通道 /v1/agent/stream 接口（§1.2-§1.3）。"""

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from app.api.auth import require_bearer_token
from app.api.streaming import stream_events
from app.models.schemas import AgentRequest
from app.workspace.manager import validate_workspace_path

router = APIRouter(prefix="/v1/agent")


@router.post("/stream")
async def stream(request: AgentRequest, _token: str = Depends(require_bearer_token)) -> StreamingResponse:
    """主通道：接收生成请求并以 SSE 流返回语义事件。"""
    # §1.2 工作区沙箱校验：workspacePath 必须位于 WORKSPACE_ROOT 之下，否则 400
    try:
        validate_workspace_path(request.workspacePath)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    return StreamingResponse(
        stream_events(request),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
