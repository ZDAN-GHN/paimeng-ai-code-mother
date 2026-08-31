"""多文件代码生成服务（HTML + CSS + JS）。"""

from collections.abc import Iterator

from langchain_core.messages import HumanMessage, SystemMessage

from app.services.codegen.base import CodeGenService
from app.services.llm import create_chat_model, load_prompt

_SYSTEM_PROMPT = "codegen-multi-file-system-prompt.txt"


class MultiFileCodeGenService(CodeGenService):
    """多文件代码生成服务（multi_file 模式）。"""

    def stream(self, user_message: str) -> Iterator[str]:
        """流式生成多文件代码文本块。"""
        model = create_chat_model()
        messages = [SystemMessage(load_prompt(_SYSTEM_PROMPT)), HumanMessage(user_message)]
        for chunk in model.stream(messages):
            text = getattr(chunk, "content", None)
            if text:
                yield str(text)
