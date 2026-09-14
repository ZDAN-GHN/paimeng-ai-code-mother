

from typing import Literal

from pydantic import BaseModel, Field

CodeGenType = Literal["html", "multi_file", "vue_project"]


class HistoryItem(BaseModel):


    role: Literal["user", "assistant"]
    content: str


class AgentRequest(BaseModel):


    appId: int = Field(gt=0)
    userId: int = Field(gt=0)
    message: str = Field(min_length=1)
    codeGenType: CodeGenType
    runId: str = Field(min_length=1)
    threadId: str = Field(min_length=1)
    workspacePath: str
    history: list[HistoryItem] = Field(default_factory=list)


class StreamMessage(BaseModel):


    type: str


class AiResponseMessage(StreamMessage):


    type: Literal["ai_response"] = "ai_response"
    data: str


class AiThinkingMessage(StreamMessage):


    type: Literal["ai_thinking"] = "ai_thinking"
    text: str


class ToolRequestMessage(StreamMessage):


    type: Literal["tool_request"] = "tool_request"
    id: str
    name: str
    arguments: str


class ToolExecutedMessage(StreamMessage):


    type: Literal["tool_executed"] = "tool_executed"
    id: str
    name: str
    arguments: str
    result: str


class CallbackRequest(BaseModel):


    runId: str = Field(min_length=1)
    appId: int = Field(gt=0)
    codeGenType: CodeGenType
    status: Literal["success", "failed"]
    message: str = ""
    workspacePath: str = ""
