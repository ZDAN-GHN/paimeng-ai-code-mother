

import asyncio
import json
from pathlib import Path

import pytest

from app.api.streaming import stream_events
from app.core.guardrails import GuardrailResult
from app.models.schemas import AgentRequest

WORKSPACE_ROOT = "/tmp/paimeng-test-workspace"


def _request(**overrides) -> AgentRequest:
    payload = {
        "appId": 1,
        "userId": 10001,
        "message": "做一个红包雨页面",
        "codeGenType": "html",
        "runId": "run-1",
        "threadId": "app:1",
        "workspacePath": f"{WORKSPACE_ROOT}/stream_test",
    }
    payload.update(overrides)
    return AgentRequest(**payload)


class _FakeGuardrail:
    def __init__(self, allowed=True) -> None:
        self._allowed = allowed

    def validate(self, text):
        return GuardrailResult.allowed() if self._allowed else GuardrailResult.rejected("拒绝：含敏感词")


class _FakeExecutor:
    def __init__(self, items=None, error=None) -> None:
        self._items = items or []
        self._error = error

    def stream(self, code_gen_type, user_message, file_tools=None):
        if self._error:
            raise self._error
        yield from self._items


class _RecordingCallback:


    def __init__(self) -> None:
        self.calls = []

    def __call__(self, *, request, status, message=""):
        self.calls.append((request, status, message))
        return True


def _collect(request, executor, guardrail=None, callback=None) -> str:


    async def _run() -> str:
        parts = [
            s
            async for s in stream_events(
                request,
                executor=executor,
                guardrail=guardrail or _FakeGuardrail(),
                callback=callback,
            )
        ]
        return "".join(parts)

    return asyncio.run(_run())


def test_html_stream_yields_text_and_writes_workspace():

    req = _request(codeGenType="html", workspacePath=f"{WORKSPACE_ROOT}/stream_html")
    out = _collect(req, _FakeExecutor(items=["```html\n", "<h1>hi</h1>\n", "```"]))
    assert "data: ```html" in out
    assert "data: <h1>hi</h1>" in out
    assert (Path(WORKSPACE_ROOT) / "stream_html" / "index.html").read_text(encoding="utf-8") == "<h1>hi</h1>"


def test_multi_file_stream_writes_three_files():

    req = _request(codeGenType="multi_file", workspacePath=f"{WORKSPACE_ROOT}/stream_mf")
    content = "```html\n<h1>a</h1>\n```\n```css\nbody{}\n```\n```javascript\nconsole.log(1)\n```"
    out = _collect(req, _FakeExecutor(items=[content]))
    ws = Path(WORKSPACE_ROOT) / "stream_mf"
    assert (ws / "index.html").read_text(encoding="utf-8") == "<h1>a</h1>"
    assert (ws / "style.css").read_text(encoding="utf-8") == "body{}"
    assert (ws / "script.js").read_text(encoding="utf-8") == "console.log(1)"


def test_vue_stream_emits_structured_events():

    req = _request(codeGenType="vue_project")
    events = [
        {"type": "ai_thinking", "text": "分析中"},
        {"type": "tool_request", "id": "t1", "name": "write_file", "arguments": '{"path":"a.js"}'},
        {"type": "tool_executed", "id": "t1", "name": "write_file", "arguments": '{"path":"a.js"}', "result": "ok"},
        {"type": "ai_response", "data": "完成"},
    ]
    out = _collect(req, _FakeExecutor(items=events))
    parsed = [json.loads(line.split("data: ", 1)[1]) for line in out.splitlines() if line.startswith("data: ")]
    assert parsed[0] == {"type": "ai_thinking", "text": "分析中"}
    assert parsed[1] == {
        "type": "tool_request",
        "id": "t1",
        "name": "write_file",
        "arguments": '{"path":"a.js"}',
    }
    assert parsed[2] == {
        "type": "tool_executed",
        "id": "t1",
        "name": "write_file",
        "arguments": '{"path":"a.js"}',
        "result": "ok",
    }
    assert parsed[3] == {"type": "ai_response", "data": "完成"}


def test_guardrail_rejection_emits_error_event():

    req = _request()
    out = _collect(req, _FakeExecutor(items=["should not appear"]), guardrail=_FakeGuardrail(allowed=False))
    assert "event: error" in out
    assert "should not appear" not in out
    assert "拒绝：含敏感词" in out


def test_generation_exception_emits_error_event():

    req = _request()
    out = _collect(req, _FakeExecutor(error=RuntimeError("模型调用失败")))
    assert "event: error" in out
    assert "模型调用失败" in out


def test_success_callback_fired_after_workspace_write():

    req = _request(codeGenType="html", workspacePath=f"{WORKSPACE_ROOT}/stream_cb")
    cb = _RecordingCallback()
    _collect(req, _FakeExecutor(items=["```html\n<h1>hi</h1>\n```"]), callback=cb)
    assert len(cb.calls) == 1
    request, status, message = cb.calls[0]
    assert status == "success"
    assert message == ""
    assert (Path(WORKSPACE_ROOT) / "stream_cb" / "index.html").exists()


def test_failed_callback_fired_on_generation_error():

    req = _request()
    cb = _RecordingCallback()
    _collect(req, _FakeExecutor(error=RuntimeError("模型调用失败")), callback=cb)
    assert len(cb.calls) == 1
    request, status, message = cb.calls[0]
    assert status == "failed"
    assert "模型调用失败" in message


def test_failed_callback_on_guardrail_rejection():

    req = _request()
    cb = _RecordingCallback()
    _collect(req, _FakeExecutor(items=["x"]), guardrail=_FakeGuardrail(allowed=False), callback=cb)
    assert len(cb.calls) == 1
    assert cb.calls[0][1] == "failed"
