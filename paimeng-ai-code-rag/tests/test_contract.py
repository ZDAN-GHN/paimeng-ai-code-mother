import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import app
from app.models.schemas import AiResponseMessage, CallbackRequest, ToolRequestMessage

TOKEN = "test-token"


@pytest.fixture(scope="module")
def client():

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

    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


@pytest.mark.contract
def test_stream_requires_auth(client):

    resp = client.post("/v1/agent/stream", json=_valid_payload())
    assert resp.status_code == 401


@pytest.mark.contract
def test_stream_with_wrong_token(client):

    resp = client.post(
        "/v1/agent/stream",
        json=_valid_payload(),
        headers={"Authorization": "Bearer wrong-token"},
    )
    assert resp.status_code == 401


@pytest.mark.contract
def test_stream_with_valid_token(client, monkeypatch):

    class _FakeExec:
        def stream(self, code_gen_type, user_message, file_tools=None):
            yield "```html\n<h1>hi</h1>\n```"

    monkeypatch.setattr("app.api.streaming.CodeGenServiceExecutor", _FakeExec)
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

    resp = client.post(
        "/v1/agent/stream",
        json=_valid_payload(workspacePath="/etc/passwd"),
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert resp.status_code == 400


@pytest.mark.contract
def test_stream_rejects_relative_path(client):

    resp = client.post(
        "/v1/agent/stream",
        json=_valid_payload(workspacePath="relative/html_1"),
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert resp.status_code == 400


@pytest.mark.contract
def test_stream_rejects_invalid_code_gen_type(client):

    resp = client.post(
        "/v1/agent/stream",
        json=_valid_payload(codeGenType="invalid"),
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert resp.status_code == 422


@pytest.mark.contract
def test_stream_rejects_empty_message(client):

    resp = client.post(
        "/v1/agent/stream",
        json=_valid_payload(message=""),
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert resp.status_code == 422


@pytest.mark.contract
def test_event_schema_aligns_with_java():

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

    assert client.get("/healthz").status_code == 200
