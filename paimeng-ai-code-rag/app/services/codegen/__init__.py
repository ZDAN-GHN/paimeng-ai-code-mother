

from __future__ import annotations

from typing import TYPE_CHECKING

from app.services.codegen.base import CodeGenService
from app.services.codegen.html import HtmlCodeGenService
from app.services.codegen.multi_file import MultiFileCodeGenService

if TYPE_CHECKING:
    from app.tools.file_tools import FileTools


_SERVICE_CLASSES: dict[str, type] = {
    "html": HtmlCodeGenService,
    "multi_file": MultiFileCodeGenService,
}


class CodeGenServiceFactory:


    def create(self, code_gen_type: str, file_tools: "FileTools | None" = None) -> CodeGenService:

        if code_gen_type == "vue_project":
            if file_tools is None:
                raise ValueError("vue_project 需要 file_tools")
            from app.services.codegen.vue import VueCodeGenService

            return VueCodeGenService(file_tools)
        service_cls = _SERVICE_CLASSES.get(code_gen_type)
        if service_cls is None:
            raise ValueError(f"不支持的代码生成类型: {code_gen_type}")
        return service_cls()


class CodeGenServiceExecutor:


    def __init__(self, factory: CodeGenServiceFactory | None = None) -> None:
        self._factory = factory or CodeGenServiceFactory()

    def stream(self, code_gen_type: str, user_message: str, file_tools: "FileTools | None" = None):

        service = self._factory.create(code_gen_type, file_tools)
        if code_gen_type == "vue_project":
            return service.run(user_message)
        return service.stream(user_message)
