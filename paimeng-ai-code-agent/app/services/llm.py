"""LangChain 模型工厂（DeepSeek，OpenAI 兼容规范）。"""

from langchain_openai import ChatOpenAI

from app.config import get_settings


def create_chat_model(*, reasoning: bool = False, temperature: float = 0.7) -> ChatOpenAI:
    """创建对话模型实例。

    :param reasoning: 是否使用推理模型（deepseek-reasoner）
    :param temperature: 采样温度
    :return: ChatOpenAI 实例
    """
    settings = get_settings()
    return ChatOpenAI(
        base_url=settings.model_base_url,
        api_key=settings.model_api_key,
        model=settings.reasoning_model_name if reasoning else settings.model_name,
        temperature=temperature,
    )


def load_prompt(name: str) -> str:
    """读取 prompts 目录下的系统提示词。

    :param name: 提示词文件名
    :return: 提示词内容
    """
    from pathlib import Path

    return (Path(__file__).resolve().parents[1] / "prompts" / name).read_text(encoding="utf-8")
