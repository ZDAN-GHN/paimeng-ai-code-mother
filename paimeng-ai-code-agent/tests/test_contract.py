"""Java↔Python 内部契约测试（§1.1-§1.4）。

- 鉴权：/v1/agent/stream 不带 Authorization 返回 401
- 健康检查：/healthz 返回 200 且 {"status":"ok"}
- 工作区沙箱校验：workspacePath 不在 WORKSPACE_ROOT 下返回 400
- 事件/回调模型与契约 schema 逐字段对齐
"""

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app
from app.models import AiResponseMessage, CallbackRequest, ToolRequestMessage

TOKEN = "test-token"


@pytest.fixture(scope="module")
def client():
    """基于真实 app 的测试客户端。"""
    return TestClient(app)


def _valid_payload(**overrides):
    payload = {
        "appId": 1,
        "userId": 10001,
        "message": "做一个红包雨页面",
        "codeGenType": "html",
        "runId": "7f2c8f9e-4d3a-4b2c-9e1f-0a1b2c3d4e5f",
        "threadId": "app:1",
        "workspacePath": "/tmp/paimeng-test-workspace/html_1",
        "history": [{"role": "user", "content": "帮我做一个抽奖页面"}],
    }
    payload.update(overrides)
    return payload


@pytest.mark.contract
def test_healthz(client):
    """/healthz 返回 200 且含 status=ok（§1.1）。"""
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


@pytest.mark.contract
def test_stream_requires_auth(client):
    """不带 Authorization 调 /v1/agent/stream 返回 401（§1.1）。"""
    resp = client.post("/v1/agent/stream", json=_valid_payload())
    assert resp.status_code == 401


@pytest.mark.contract
def test_stream_with_wrong_token(client):
    """令牌错误返回 401（§1.1）。"""
    resp = client.post(
        "/v1/agent/stream",
        json=_valid_payload(),
        headers={"Authorization": "Bearer wrong-token"},
    )
    assert resp.status_code == 401


@pytest.mark.contract
def test_stream_with_valid_token(client, monkeypatch):
    """合法令牌返回 SSE 流（§1.3，mock 生成器避免在线调用）。"""

    class _FakeExec:
        def stream(self, code_gen_type, user_message, file_tools=None):
            yield "```html\n<h1>hi</h1>\n```"

    monkeypatch.setattr("app.streaming.CodeGenServiceExecutor", _FakeExec)
    resp = client.post(
        "/v1/agent/stream",
        json=_valid_payload(),
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert resp.status_code == 200
    assert "text/event-stream" in resp.headers["content-type"]
    assert "data:" in resp.text
    assert "<h1>hi</h1>" in resp.text


@pytest.mark.contract
def test_stream_rejects_path_traversal(client):
    """workspacePath 不在 WORKSPACE_ROOT 下返回 400（§1.2 沙箱校验）。"""
    resp = client.post(
        "/v1/agent/stream",
        json=_valid_payload(workspacePath="/etc/passwd"),
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert resp.status_code == 400


@pytest.mark.contract
def test_stream_rejects_relative_path(client):
    """workspacePath 非绝对路径返回 400（§1.2 沙箱校验）。"""
    resp = client.post(
        "/v1/agent/stream",
        json=_valid_payload(workspacePath="relative/html_1"),
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert resp.status_code == 400


@pytest.mark.contract
def test_stream_rejects_invalid_code_gen_type(client):
    """codeGenType 不在 {html,multi_file,vue_project} 内返回 422（§1.2 字段约束）。"""
    resp = client.post(
        "/v1/agent/stream",
        json=_valid_payload(codeGenType="invalid"),
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert resp.status_code == 422


@pytest.mark.contract
def test_stream_rejects_empty_message(client):
    """message 为空返回 422（§1.2 字段约束）。"""
    resp = client.post(
        "/v1/agent/stream",
        json=_valid_payload(message=""),
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert resp.status_code == 422


@pytest.mark.contract
def test_event_schema_aligns_with_java():
    """事件 JSON 字段与旧 Java StreamMessage 逐字段对齐（§1.3）。"""
    msg = AiResponseMessage(data="增量文本")
    assert msg.model_dump() == {"type": "ai_response", "data": "增量文本"}

    msg = ToolRequestMessage(id="t1", name="write", arguments='{"path":"a.html"}')
    assert msg.model_dump() == {
        "type": "tool_request",
        "id": "t1",
        "name": "write",
        "arguments": '{"path":"a.html"}',
    }


@pytest.mark.contract
def test_callback_schema_alignment():
    """回调字段与 §1.4 逐字段对齐，status 仅接受 success/failed。"""
    req = CallbackRequest(
        runId="7f2c8f9e-4d3a-4b2c-9e1f-0a1b2c3d4e5f",
        appId=1,
        codeGenType="html",
        status="success",
    )
    assert req.model_dump() == {
        "runId": "7f2c8f9e-4d3a-4b2c-9e1f-0a1b2c3d4e5f",
        "appId": 1,
        "codeGenType": "html",
        "status": "success",
        "message": "",
        "workspacePath": "",
    }
    with pytest.raises(Exception):
        CallbackRequest(runId="r", appId=1, codeGenType="html", status="pending")


@pytest.mark.contract
def test_healthz_does_not_require_auth(client):
    """健康检查不鉴权（§1.1 健康检查通道）。"""
    assert client.get("/healthz").status_code == 200
