"""PostgreSQL checkpoint 恢复测试（T19，§1.5 首次判定）。

同一 thread_id 第二次请求应恢复 checkpoint（不重复 bootstrap）：
- 首次（无 checkpoint）：has_checkpoint=False，用请求 history 初始化
- 后续（有 checkpoint）：has_checkpoint=True，从 checkpoint 恢复并忽略请求 history

需要本机 PostgreSQL 实例（DATABASE_URL 指向 paimeng_test 库）。
"""

from typing import TypedDict
from uuid import uuid4

import pytest
from langgraph.graph import END, START, StateGraph

from app.core.state import get_checkpointer, has_checkpoint, thread_config


class _CountState(TypedDict, total=False):
    """计数器状态（持久化到 checkpoint）。"""

    count: int


def _unique_thread(prefix: str = "app") -> str:
    """生成唯一的 thread_id（checkpoint 数据持久化在库中，需按次隔离）。"""
    return f"{prefix}:{uuid4().hex}"


def _build_counter_graph():
    """构建一个自增计数器图（带 PostgresSaver checkpointer）。"""

    def increment(state: _CountState) -> _CountState:
        return {"count": (state.get("count") or 0) + 1}

    graph = StateGraph(_CountState)
    graph.add_node("increment", increment)
    graph.add_edge(START, "increment")
    graph.add_edge("increment", END)
    return graph.compile(checkpointer=get_checkpointer())


@pytest.mark.checkpoint
def test_first_use_no_checkpoint():
    """首次：thread_id 无 checkpoint（应 bootstrap history）。"""
    assert has_checkpoint("app:99999") is False


@pytest.mark.checkpoint
def test_checkpoint_persists_and_restores():
    """同一 thread_id：首次生成后写入 checkpoint，第二次请求从 checkpoint 恢复。"""
    thread = _unique_thread()
    graph = _build_counter_graph()

    # 首次请求：无 checkpoint，从 0 初始化
    assert has_checkpoint(thread) is False
    result = graph.invoke({"count": 0}, config=thread_config(thread))
    assert result["count"] == 1
    # 生成结束后应已写入 checkpoint —— 第二次请求不应重新 bootstrap
    assert has_checkpoint(thread) is True

    # 第二次请求：从 checkpoint 恢复（count=1 已持久化），继续累加
    result2 = graph.invoke({}, config=thread_config(thread))
    assert result2["count"] == 2
    assert has_checkpoint(thread) is True


@pytest.mark.checkpoint
def test_threads_are_isolated():
    """不同 thread_id 的 checkpoint 相互隔离（app:{appId} 各自独立）。"""
    graph = _build_counter_graph()
    thread_a = _unique_thread()
    thread_b = _unique_thread()
    graph.invoke({"count": 0}, config=thread_config(thread_a))
    # thread_a 有 checkpoint，thread_b 没有
    assert has_checkpoint(thread_a) is True
    assert has_checkpoint(thread_b) is False
