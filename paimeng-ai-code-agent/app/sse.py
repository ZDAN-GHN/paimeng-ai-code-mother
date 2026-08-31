"""SSE 序列化辅助（§1.3 A5）。

约定：事件以空行分隔；data: 多行内容以 \\n 拼接为多个 data: 行；
文本块内换行逐行拆分为独立 data: 行，避免与事件分隔冲突。
"""

from collections.abc import Iterator

from app.models import StreamMessage


def format_data(data: str) -> str:
    """把单条 data 内容格式化为多个 data: 行（含行尾空行分隔）。"""
    lines = [f"data: {line}" for line in data.split("\n")]
    return "\n".join(lines) + "\n\n"


def format_event(event: str | None, data: str) -> str:
    """格式化一条 SSE 事件（可带 event 字段）。"""
    body = [f"data: {line}" for line in data.split("\n")]
    if event:
        body.insert(0, f"event: {event}")
    return "\n".join(body) + "\n\n"


def encode_stream_message(message: StreamMessage) -> str:
    """把结构化事件编码为 SSE 文本（vue_project 用）。"""
    return format_data(message.model_dump_json())


def iter_text_chunks(chunks: Iterator[str]) -> Iterator[str]:
    """把纯文本块逐个编码为 SSE 文本（html/multi_file 用）。"""
    for chunk in chunks:
        yield format_data(chunk)
