from abc import ABC, abstractmethod
from collections.abc import Iterator

from app.services.codegen.parsing import HtmlCodeResult, MultiFileCodeResult


class CodeGenService(ABC):
    @abstractmethod
    def stream(self, user_message: str) -> Iterator[str]:
        pass
