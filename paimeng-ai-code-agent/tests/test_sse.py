"""SSE 序列化约定测试（§1.3 A5）。"""

import pytest

from app.api.sse import encode_stream_message, format_data, format_event
from app.models.schemas import AiResponseMessage


@pytest.mark.sse
def test_format_data_splits_newlines():
    """文本块内换行逐行拆分为独立 data: 行，且以空行结尾。"""
    assert format_data("line1\nline2") == "data: line1\ndata: line2\n\n"


@pytest.mark.sse
def test_format_event_with_event_field():
    """带 event 字段时 event 行位于 data 之前。"""
    assert format_event("error", '{"message":"boom"}') == (
        'event: error\ndata: {"message":"boom"}\n\n'
    )


@pytest.mark.sse
def test_encode_stream_message_is_single_data_line():
    """结构化事件编码为单行 JSON 的 data: 行（vue_project 用）。"""
    msg = AiResponseMessage(data="增量")
    expected = 'data: {"type":"ai_response","data":"增量"}\n\n'
    assert encode_stream_message(msg) == expected
