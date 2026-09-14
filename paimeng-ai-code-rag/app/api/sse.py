

from collections.abc import Iterator

from app.models.schemas import StreamMessage


def format_data(data: str) -> str:

    lines = [f"data: {line}" for line in data.split("\n")]
    return "\n".join(lines) + "\n\n"


def format_event(event: str | None, data: str) -> str:

    body = [f"data: {line}" for line in data.split("\n")]
    if event:
        body.insert(0, f"event: {event}")
    return "\n".join(body) + "\n\n"


def encode_stream_message(message: StreamMessage) -> str:

    return format_data(message.model_dump_json())


def iter_text_chunks(chunks: Iterator[str]) -> Iterator[str]:

    for chunk in chunks:
        yield format_data(chunk)
