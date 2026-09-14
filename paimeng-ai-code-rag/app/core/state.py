

from functools import lru_cache
from typing import Any, TypedDict

from langgraph.checkpoint.postgres import PostgresSaver
from psycopg_pool import ConnectionPool

from app.core.config import get_settings


class AgentState(TypedDict, total=False):


    message: str
    code_gen_type: str
    workspace_path: str
    run_id: str
    history: list[dict[str, str]]


@lru_cache
def _pool() -> ConnectionPool:

    settings = get_settings()
    return ConnectionPool(conninfo=settings.database_url, kwargs={"autocommit": True}, open=True)


def get_checkpointer() -> PostgresSaver:

    saver = PostgresSaver(_pool())
    saver.setup()
    return saver


def thread_config(thread_id: str) -> dict[str, Any]:

    return {"configurable": {"thread_id": thread_id}}


def has_checkpoint(thread_id: str) -> bool:

    saver = get_checkpointer()
    return saver.get_tuple(thread_config(thread_id)) is not None
