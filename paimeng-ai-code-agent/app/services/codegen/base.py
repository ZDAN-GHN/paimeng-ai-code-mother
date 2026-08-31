"""代码生成服务基类。"""

from abc import ABC, abstractmethod
from collections.abc import Iterator

from app.services.codegen.parsing import HtmlCodeResult, MultiFileCodeResult


class CodeGenService(ABC):
    """代码生成服务抽象基类。"""

    @abstractmethod
    def stream(self, user_message: str) -> Iterator[str]:
        """流式生成代码（逐块纯文本）。

        :param user_message: 增强后的用户提示词
        :return: 逐块文本迭代器
        """
