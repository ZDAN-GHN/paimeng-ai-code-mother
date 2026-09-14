

import logging
from typing import Any, Literal

import httpx

from app.core.config import get_settings
from app.models.schemas import AgentRequest, CallbackRequest

logger = logging.getLogger(__name__)


CALLBACK_PATH = "/api/app/chat/gen/code/callback"

CallbackStatus = Literal["success", "failed"]


def build_callback_url() -> str:

    settings = get_settings()
    return f"{settings.java_base_url.rstrip('/')}{CALLBACK_PATH}"


def _auth_headers() -> dict[str, str]:

    settings = get_settings()
    return {
        "Authorization": f"Bearer {settings.python_agent_token}",
        "Content-Type": "application/json",
    }


def send_callback(
    *,
    run_id: str,
    app_id: int,
    code_gen_type: str,
    status: CallbackStatus,
    message: str = "",
    workspace_path: str = "",
    http_client: httpx.Client | None = None,
) -> bool:

    payload = CallbackRequest(
        runId=run_id,
        appId=app_id,
        codeGenType=code_gen_type,
        status=status,
        message=message,
        workspacePath=workspace_path,
    )
    own_client = http_client is None
    client = http_client or httpx.Client(timeout=10.0)
    try:
        response = client.post(
            build_callback_url(),
            json=payload.model_dump(),
            headers=_auth_headers(),
        )
        response.raise_for_status()
        logger.info("完成回调发送成功: runId=%s status=%s", run_id, status)
        return True
    except Exception as exc:  # noqa: BLE001
        logger.error("完成回调发送失败: runId=%s status=%s: %s", run_id, status, exc)
        return False
    finally:
        if own_client:
            client.close()


def send_request_callback(
    request: AgentRequest,
    status: CallbackStatus,
    *,
    message: str = "",
    http_client: httpx.Client | None = None,
) -> bool:

    return send_callback(
        run_id=request.runId,
        app_id=request.appId,
        code_gen_type=request.codeGenType,
        status=status,
        message=message,
        workspace_path=request.workspacePath,
        http_client=http_client,
    )
