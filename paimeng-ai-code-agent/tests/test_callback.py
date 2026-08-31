"""完成回调客户端测试（T13）：URL 拼接、Bearer 头、成功/失败状态。"""

import httpx
import pytest

from app.callback import build_callback_url, send_callback
from app.config import get_settings


class _FakeResponse:
    """模拟 httpx 响应。"""

    def __init__(self, ok: bool) -> None:
        self._ok = ok

    def raise_for_status(self):
        if not self._ok:
            raise httpx.HTTPStatusError("err", request=None, response=None)


class _RecordingClient:
    """记录请求的假 HTTP 客户端。"""

    def __init__(self, ok: bool = True) -> None:
        self._ok = ok
        self.calls = []

    def post(self, url, *, json=None, headers=None):
        self.calls.append((url, json, headers))
        return _FakeResponse(self._ok)

    def close(self):
        pass


def test_build_callback_url(monkeypatch):
    """回调 URL 拼接为 {JAVA_BASE_URL}/api/app/chat/gen/code/callback。"""
    assert build_callback_url() == "http://localhost:8123/api/app/chat/gen/code/callback"


def test_send_callback_success():
    """success 回调请求体与头对齐 §1.4。"""
    client = _RecordingClient(ok=True)
    ok = send_callback(
        run_id="run-1",
        app_id=1,
        code_gen_type="html",
        status="success",
        workspace_path="/tmp/ws/html_1",
        http_client=client,
    )
    assert ok is True
    url, body, headers = client.calls[0]
    assert url == build_callback_url()
    assert body == {
        "runId": "run-1",
        "appId": 1,
        "codeGenType": "html",
        "status": "success",
        "message": "",
        "workspacePath": "/tmp/ws/html_1",
    }
    token = get_settings().python_agent_token
    assert headers["Authorization"] == f"Bearer {token}"


def test_send_callback_failed_carries_message():
    """failed 回调携带 message。"""
    client = _RecordingClient(ok=True)
    send_callback(
        run_id="run-2",
        app_id=2,
        code_gen_type="vue_project",
        status="failed",
        message="生成失败",
        http_client=client,
    )
    _, body, _ = client.calls[0]
    assert body["status"] == "failed"
    assert body["message"] == "生成失败"
    assert body["codeGenType"] == "vue_project"


def test_send_callback_http_error_returns_false():
    """Java 返回非 2xx 时回调视为失败但不抛出。"""
    client = _RecordingClient(ok=False)
    ok = send_callback(
        run_id="run-3",
        app_id=1,
        code_gen_type="html",
        status="success",
        http_client=client,
    )
    assert ok is False
