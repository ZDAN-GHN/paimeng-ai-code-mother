"""LangGraph 状态与 PostgreSQL checkpointer 装配（§1.5 首次判定）。"""

from functools import lru_cache
from typing import Any, TypedDict

from langgraph.checkpoint.postgres import PostgresSaver
from psycopg_pool import ConnectionPool

from app.core.config import get_settings


class AgentState(TypedDict, total=False):
    """LangGraph 工作流状态（阶段 2 迁移节点时扩展字段）。"""

    message: str
    code_gen_type: str
    workspace_path: str
    run_id: str
    history: list[dict[str, str]]


@lru_cache
def _pool() -> ConnectionPool:
    """PostgreSQL 连接池（懒创建，仅用于 LangGraph checkpoint）。

    autocommit=True：PostgresSaver.setup() 含 CREATE INDEX CONCURRENTLY，
    必须在无事务块下执行（langgraph-checkpoint-postgres 要求连接为自动提交模式）。
    """
    settings = get_settings()
    return ConnectionPool(conninfo=settings.database_url, kwargs={"autocommit": True}, open=True)


def get_checkpointer() -> PostgresSaver:
    """获取 PostgresSaver（首次使用时建表）。"""
    saver = PostgresSaver(_pool())
    saver.setup()
    return saver


def thread_config(thread_id: str) -> dict[str, Any]:
    """构造 LangGraph 运行配置，thread_id = app:{appId}。"""
    return {"configurable": {"thread_id": thread_id}}


def has_checkpoint(thread_id: str) -> bool:
    """判断 thread_id 是否已有 checkpoint（首次判定，§1.5）。

    有则从 checkpoint 恢复并忽略请求 history；无则用请求 history 初始化。
    """
    saver = get_checkpointer()
    return saver.get_tuple(thread_config(thread_id)) is not None
