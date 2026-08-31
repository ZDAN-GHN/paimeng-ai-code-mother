"""SSE 流式输出适配测试（T12）：事件映射、落盘、错误事件。"""

import asyncio
import json
from pathlib import Path

import pytest

from app.guardrails import GuardrailResult
from app.models import AgentRequest
from app.streaming import stream_events

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


def _collect(request, executor, guardrail=None) -> str:
    """收集 stream_events 的完整 SSE 输出。"""

    async def _run() -> str:
        parts = [s async for s in stream_events(request, executor=executor, guardrail=guardrail or _FakeGuardrail())]
        return "".join(parts)

    return asyncio.run(_run())


def test_html_stream_yields_text_and_writes_workspace():
    """html：纯文本块 SSE + 解析落盘 index.html。"""
    req = _request(codeGenType="html", workspacePath=f"{WORKSPACE_ROOT}/stream_html")
    out = _collect(req, _FakeExecutor(items=["```html\n", "<h1>hi</h1>\n", "```"]))
    assert "data: ```html" in out
    assert "data: <h1>hi</h1>" in out
    assert (Path(WORKSPACE_ROOT) / "stream_html" / "index.html").read_text(encoding="utf-8") == "<h1>hi</h1>"


def test_multi_file_stream_writes_three_files():
    """multi_file：三文件解析落盘。"""
    req = _request(codeGenType="multi_file", workspacePath=f"{WORKSPACE_ROOT}/stream_mf")
    content = "```html\n<h1>a</h1>\n```\n```css\nbody{}\n```\n```javascript\nconsole.log(1)\n```"
    out = _collect(req, _FakeExecutor(items=[content]))
    ws = Path(WORKSPACE_ROOT) / "stream_mf"
    assert (ws / "index.html").read_text(encoding="utf-8") == "<h1>a</h1>"
    assert (ws / "style.css").read_text(encoding="utf-8") == "body{}"
    assert (ws / "script.js").read_text(encoding="utf-8") == "console.log(1)"


def test_vue_stream_emits_structured_events():
    """vue_project：事件 dict 归一化为 §1.3 StreamMessage JSON。"""
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
    """护轨拒绝：发 error 事件且不再发业务事件。"""
    req = _request()
    out = _collect(req, _FakeExecutor(items=["should not appear"]), guardrail=_FakeGuardrail(allowed=False))
    assert "event: error" in out
    assert "should not appear" not in out
    assert "拒绝：含敏感词" in out


def test_generation_exception_emits_error_event():
    """生成异常：发 error 事件。"""
    req = _request()
    out = _collect(req, _FakeExecutor(error=RuntimeError("模型调用失败")))
    assert "event: error" in out
    assert "模型调用失败" in out
