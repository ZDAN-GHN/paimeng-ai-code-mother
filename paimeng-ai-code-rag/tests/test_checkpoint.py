

from typing import TypedDict
from uuid import uuid4

import pytest
from langgraph.graph import END, START, StateGraph

from app.core.state import get_checkpointer, has_checkpoint, thread_config


class _CountState(TypedDict, total=False):


    count: int


def _unique_thread(prefix: str = "app") -> str:

    return f"{prefix}:{uuid4().hex}"


def _build_counter_graph():


    def increment(state: _CountState) -> _CountState:
        return {"count": (state.get("count") or 0) + 1}

    graph = StateGraph(_CountState)
    graph.add_node("increment", increment)
    graph.add_edge(START, "increment")
    graph.add_edge("increment", END)
    return graph.compile(checkpointer=get_checkpointer())


@pytest.mark.checkpoint
def test_first_use_no_checkpoint():

    assert has_checkpoint("app:99999") is False


@pytest.mark.checkpoint
def test_checkpoint_persists_and_restores():

    thread = _unique_thread()
    graph = _build_counter_graph()


    assert has_checkpoint(thread) is False
    result = graph.invoke({"count": 0}, config=thread_config(thread))
    assert result["count"] == 1

    assert has_checkpoint(thread) is True


    result2 = graph.invoke({}, config=thread_config(thread))
    assert result2["count"] == 2
    assert has_checkpoint(thread) is True


@pytest.mark.checkpoint
def test_threads_are_isolated():

    graph = _build_counter_graph()
    thread_a = _unique_thread()
    thread_b = _unique_thread()
    graph.invoke({"count": 0}, config=thread_config(thread_a))

    assert has_checkpoint(thread_a) is True
    assert has_checkpoint(thread_b) is False
