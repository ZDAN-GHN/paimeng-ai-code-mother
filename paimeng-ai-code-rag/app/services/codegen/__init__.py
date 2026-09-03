"""代码生成服务工厂与执行器（迁移自 AiCodeGenServiceExecutor/Factory）。

html / multi_file 使用纯文本流 + 代码解析；vue_project 使用工具驱动。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.services.codegen.base import CodeGenService
from app.services.codegen.html import HtmlCodeGenService
from app.services.codegen.multi_file import MultiFileCodeGenService

if TYPE_CHECKING:
    from app.tools.file_tools import FileTools

# 代码生成类型 -> 服务类（对齐 CodeGenTypeEnum.value）
_SERVICE_CLASSES: dict[str, type] = {
    "html": HtmlCodeGenService,
    "multi_file": MultiFileCodeGenService,
}


class CodeGenServiceFactory:
    """创建各类型的代码生成服务实例。"""

    def create(self, code_gen_type: str, file_tools: "FileTools | None" = None) -> CodeGenService:
        """创建代码生成服务。

        :param code_gen_type: html / multi_file / vue_project
        :param file_tools: vue_project 需要的工作区文件工具
        :return: 代码生成服务实例
        :raises ValueError: 不支持的代码生成类型
        """
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
    """按类型分发执行代码生成。"""

    def __init__(self, factory: CodeGenServiceFactory | None = None) -> None:
        self._factory = factory or CodeGenServiceFactory()

    def stream(self, code_gen_type: str, user_message: str, file_tools: "FileTools | None" = None):
        """执行代码生成（vue_project 返回事件流，其余返回纯文本块流）。

        :param code_gen_type: html / multi_file / vue_project
        :param user_message: 增强后的用户提示词
        :param file_tools: vue_project 需要的工作区文件工具
        """
        service = self._factory.create(code_gen_type, file_tools)
        if code_gen_type == "vue_project":
            return service.run(user_message)
        return service.stream(user_message)
