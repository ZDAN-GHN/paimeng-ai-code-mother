

import json
import uuid
from collections.abc import Iterator
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool as langchain_tool

from app.services.codegen.base import CodeGenService
from app.services.llm import create_chat_model, load_prompt
from app.tools.file_tools import FileTools

_SYSTEM_PROMPT = "codegen-vue-project-system-prompt.txt"


class VueCodeGenService(CodeGenService):


    MAX_TOOL_CALLS = 50

    def __init__(self, file_tools: FileTools) -> None:

        self._file_tools = file_tools

    def _tools(self) -> list[Any]:

        ft = self._file_tools



        @langchain_tool("writeFile")
        def write_file(relativeFilePath: str, content: str) -> str:

            return ft.write_file(relativeFilePath, content)

        @langchain_tool("readFile")
        def read_file(relativeFilePath: str) -> str:

            return ft.read_file(relativeFilePath)

        @langchain_tool("modifyFile")
        def modify_file(relativeFilePath: str, oldContent: str, newContent: str) -> str:

            return ft.modify_file(relativeFilePath, oldContent, newContent)

        @langchain_tool("deleteFile")
        def delete_file(relativeFilePath: str) -> str:

            return ft.delete_file(relativeFilePath)

        @langchain_tool("readDir")
        def read_dir(relativeDirPath: str = "") -> str:

            return ft.read_dir(relativeDirPath or None)

        @langchain_tool("exit")
        def exit_tool() -> str:

            return FileTools.exit_tool()

        return [write_file, read_file, modify_file, delete_file, read_dir, exit_tool]

    def stream(self, user_message: str) -> Iterator[str]:

        raise NotImplementedError("vue 模式请使用 run() 获取结构化事件流")

    def run(self, user_message: str) -> Iterator[dict[str, str]]:

        model = create_chat_model(reasoning=True).bind_tools(self._tools())
        messages = [SystemMessage(load_prompt(_SYSTEM_PROMPT)), HumanMessage(user_message)]

        exit_called = False

        for _ in range(self.MAX_TOOL_CALLS):
            response = model.invoke(messages)
            messages.append(response)

            tool_calls = getattr(response, "tool_calls", None) or []
            if not tool_calls:

                if not exit_called:
                    exit_id = f"exit-{uuid.uuid4()}"
                    yield {"type": "tool_request", "id": exit_id, "name": "exit", "arguments": "{}"}
                    yield {
                        "type": "tool_executed",
                        "id": exit_id,
                        "name": "exit",
                        "arguments": "{}",
                        "result": FileTools.exit_tool(),
                    }
                content = response.content or ""
                if content:
                    yield {"type": "ai_response", "data": str(content)}
                break

            for tool_call in tool_calls:
                name = tool_call["name"]
                if name == "exit":
                    exit_called = True
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

        ft = self._file_tools
        if tool_name == "writeFile":
            return ft.write_file(args["relativeFilePath"], args["content"])
        if tool_name == "readFile":
            return ft.read_file(args["relativeFilePath"])
        if tool_name == "modifyFile":
            return ft.modify_file(args["relativeFilePath"], args["oldContent"], args["newContent"])
        if tool_name == "deleteFile":
            return ft.delete_file(args["relativeFilePath"])
        if tool_name == "readDir":
            return ft.read_dir(args.get("relativeDirPath") or None)
        if tool_name == "exit":
            return FileTools.exit_tool()
        return f"错误：不存在的工具 {tool_name}"
