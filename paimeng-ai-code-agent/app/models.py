"""Pydantic 请求 / 事件 / 回调模型。

字段名、事件名、顺序与 docs/py_agent/task_plan.md §1.2-§1.4 逐字段对齐，不得自行改动。
"""

from typing import Literal

from pydantic import BaseModel, Field

CodeGenType = Literal["html", "multi_file", "vue_project"]


class HistoryItem(BaseModel):
    """对话历史条目。"""

    role: Literal["user", "assistant"]
    content: str


class AgentRequest(BaseModel):
    """主通道请求体（§1.2）。"""

    appId: int = Field(gt=0)
    userId: int = Field(gt=0)
    message: str = Field(min_length=1)
    codeGenType: CodeGenType
    runId: str = Field(min_length=1)
    threadId: str = Field(min_length=1)
    workspacePath: str
    history: list[HistoryItem] = Field(default_factory=list)


class StreamMessage(BaseModel):
    """流式事件基类。"""

    type: str


class AiResponseMessage(StreamMessage):
    """AI 响应事件，data 为逐块增量文本。"""

    type: Literal["ai_response"] = "ai_response"
    data: str


class AiThinkingMessage(StreamMessage):
    """AI 思考事件，text 为逐块增量文本。"""

    type: Literal["ai_thinking"] = "ai_thinking"
    text: str


class ToolRequestMessage(StreamMessage):
    """工具请求事件，Java 按 id 首次去重展示。"""

    type: Literal["tool_request"] = "tool_request"
    id: str
    name: str
    arguments: str


class ToolExecutedMessage(StreamMessage):
    """工具执行结果事件，Java 按 name+arguments 生成结果文本。"""

    type: Literal["tool_executed"] = "tool_executed"
    id: str
    name: str
    arguments: str
    result: str


class CallbackRequest(BaseModel):
    """完成回调请求体（§1.4），status 仅接受 success/failed。"""

    runId: str = Field(min_length=1)
    appId: int = Field(gt=0)
    codeGenType: CodeGenType
    status: Literal["success", "failed"]
    message: str = ""
    workspacePath: str = ""
