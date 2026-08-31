"""Vue 工程代码生成服务（工具驱动，vue_project 模式）。

通过文件类工具逐文件创建 Vue 项目，返回事件流
（ai_thinking / tool_request / tool_executed / ai_response），
由 streaming 适配层格式化为 §1.3 事件。
"""

import json
from collections.abc import Iterator
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool as langchain_tool

from app.services.codegen.base import CodeGenService
from app.services.llm import create_chat_model, load_prompt
from app.tools.file_tools import FileTools

_SYSTEM_PROMPT = "codegen-vue-project-system-prompt.txt"


class VueCodeGenService(CodeGenService):
    """Vue 工程代码生成服务：推理模型 + 文件工具循环建项目。"""

    MAX_TOOL_CALLS = 50

    def __init__(self, file_tools: FileTools) -> None:
        """绑定到当前请求的工作区。

        :param file_tools: 已绑定工作区的文件工具集
        """
        self._file_tools = file_tools

    def _tools(self) -> list[Any]:
        """把文件工具绑定为 LangChain 工具（对齐 Java VueCodeGenService.getTools）。"""
        ft = self._file_tools

        @langchain_tool
        def write_file(relative_file_path: str, content: str) -> str:
            """写入文件到指定路径"""
            return ft.write_file(relative_file_path, content)

        @langchain_tool
        def read_file(relative_file_path: str) -> str:
            """读取指定路径的文件内容"""
            return ft.read_file(relative_file_path)

        @langchain_tool
        def modify_file(relative_file_path: str, old_content: str, new_content: str) -> str:
            """修改文件内容，用新内容替换指定的旧内容"""
            return ft.modify_file(relative_file_path, old_content, new_content)

        @langchain_tool
        def delete_file(relative_file_path: str) -> str:
            """删除指定路径的文件"""
            return ft.delete_file(relative_file_path)

        @langchain_tool
        def read_dir(relative_dir_path: str = "") -> str:
            """读取目录结构，获取指定目录下的所有文件和子目录信息"""
            return ft.read_dir(relative_dir_path or None)

        @langchain_tool
        def exit_tool() -> str:
            """当任务已完成或无需继续调用工具时，使用此工具退出操作，防止循环"""
            return FileTools.exit_tool()

        return [write_file, read_file, modify_file, delete_file, read_dir, exit_tool]

    def stream(self, user_message: str) -> Iterator[str]:
        """兼容基类：vue 模式不使用纯文本流，直接跑工具循环。

        :raises NotImplementedError: 请使用 run()
        """
        raise NotImplementedError("vue 模式请使用 run() 获取结构化事件流")

    def run(self, user_message: str) -> Iterator[dict[str, str]]:
        """驱动模型 + 文件工具循环，产出结构化事件。

        :param user_message: 增强后的用户提示词
        :return: 事件 dict（type ∈ ai_thinking/tool_request/tool_executed/ai_response）
        """
        model = create_chat_model(reasoning=True).bind_tools(self._tools())
        messages = [SystemMessage(load_prompt(_SYSTEM_PROMPT)), HumanMessage(user_message)]

        for _ in range(self.MAX_TOOL_CALLS):
            response = model.invoke(messages)
            messages.append(response)

            tool_calls = getattr(response, "tool_calls", None) or []
            if not tool_calls:
                content = response.content or ""
                if content:
                    yield {"type": "ai_response", "data": str(content)}
                break

            for tool_call in tool_calls:
                name = tool_call["name"]
                arguments = json.dumps(tool_call.get("args", {}), ensure_ascii=False)
                yield {"type": "tool_request", "id": tool_call["id"], "name": name, "arguments": arguments}
                result = self._execute(name, tool_call.get("args", {}))
                yield {
                    "type": "tool_executed",
                    "id": tool_call["id"],
                    "name": name,
                    "arguments": arguments,
                    "result": result,
                }
                messages.append(ToolMessage(str(result), tool_call_id=tool_call["id"]))

    def _execute(self, tool_name: str, args: dict[str, Any]) -> str:
        """执行工具调用。

        :param tool_name: 工具名
        :param args: 工具参数
        :return: 工具执行结果文本
        """
        ft = self._file_tools
        if tool_name == "write_file":
            return ft.write_file(args["relative_file_path"], args["content"])
        if tool_name == "read_file":
            return ft.read_file(args["relative_file_path"])
        if tool_name == "modify_file":
            return ft.modify_file(args["relative_file_path"], args["old_content"], args["new_content"])
        if tool_name == "delete_file":
            return ft.delete_file(args["relative_file_path"])
        if tool_name == "read_dir":
            return ft.read_dir(args.get("relative_dir_path") or None)
        if tool_name == "exit_tool":
            return FileTools.exit_tool()
        return f"错误：不存在的工具 {tool_name}"
