import pytest

from app.api.sse import encode_stream_message, format_data, format_event
from app.models.schemas import AiResponseMessage


@pytest.mark.sse
def test_format_data_splits_newlines():

    assert format_data("line1\nline2") == "data: line1\ndata: line2\n\n"


@pytest.mark.sse
def test_format_event_with_event_field():

    assert format_event("error", '{"message":"boom"}') == (
        'event: error\ndata: {"message":"boom"}\n\n'
    )


@pytest.mark.sse
def test_encode_stream_message_is_single_data_line():

    msg = AiResponseMessage(data="增量")
    expected = 'data: {"type":"ai_response","data":"增量"}\n\n'
    assert encode_stream_message(msg) == expected
