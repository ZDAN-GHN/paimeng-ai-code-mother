from langchain_openai import ChatOpenAI

from app.core.config import get_settings


def create_chat_model(
    *, reasoning: bool = False, temperature: float = 0.7
) -> ChatOpenAI:

    settings = get_settings()
    return ChatOpenAI(
        base_url=settings.model_base_url,
        api_key=settings.model_api_key,
        model=settings.reasoning_model_name if reasoning else settings.model_name,
        temperature=temperature,
    )


def load_prompt(name: str) -> str:

    from pathlib import Path

    return (Path(__file__).resolve().parents[1] / "prompts" / name).read_text(
        encoding="utf-8"
    )
