"""完成回调客户端（T13）：工作流完成后按 §1.4 调用 Java 回调。

- 唯一完成信号：Python 写完工作区全部文件后调 success；中途失败调 failed + message。
- 目标：`POST {JAVA_BASE_URL}/api/app/chat/gen/code/callback`（Java 内部接口，不走用户鉴权，仅 Bearer）。
- 幂等由 Java 侧按 runId 保证（重复回调直接丢弃）。
"""

import logging
from typing import Any, Literal

import httpx

from app.core.config import get_settings
from app.models.schemas import AgentRequest, CallbackRequest

logger = logging.getLogger(__name__)

# Java 回调 endpoint（对外全路径，含 context-path /api）
CALLBACK_PATH = "/api/app/chat/gen/code/callback"

CallbackStatus = Literal["success", "failed"]


def build_callback_url() -> str:
    """拼接 Java 回调完整 URL。

    :return: 完整回调地址
    """
    settings = get_settings()
    return f"{settings.java_base_url.rstrip('/')}{CALLBACK_PATH}"


def _auth_headers() -> dict[str, str]:
    """构造回调请求头（内部接口仅校验 Bearer，无用户 Cookie）。"""
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
    """发送完成回调到 Java（§1.4）。

    :param run_id: 请求 runId（Java 幂等键）
    :param app_id: 应用 id
    :param code_gen_type: 代码生成类型（html/multi_file/vue_project）
    :param status: 完成状态（success/failed）
    :param message: 失败时的错误信息
    :param workspace_path: 工作区绝对路径
    :param http_client: 可注入的 HTTP 客户端（测试 mock 用）
    :return: 是否发送成功（2xx 视为成功）
    """
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
    except Exception as exc:  # noqa: BLE001 - 回调失败不抛出，避免影响主流程
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
    """按 AgentRequest 发送完成回调（stream_events 便捷入口）。

    :param request: 主通道请求（§1.2）
    :param status: 完成状态（success/failed）
    :param message: 失败时的错误信息
    :param http_client: 可注入的 HTTP 客户端（测试 mock 用）
    :return: 是否发送成功
    """
    return send_callback(
        run_id=request.runId,
        app_id=request.appId,
        code_gen_type=request.codeGenType,
        status=status,
        message=message,
        workspace_path=request.workspacePath,
        http_client=http_client,
    )
