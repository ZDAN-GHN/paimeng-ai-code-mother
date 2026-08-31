"""代码生成类型智能路由服务（迁移自 AiCodeGenTypeRoutingService）。"""

from langchain_core.messages import HumanMessage, SystemMessage

from app.services.llm import create_chat_model, load_prompt

_SYSTEM_PROMPT = "codegen-routing-system-prompt.txt"

# 与 CodeGenTypeEnum.value 一致
CODE_GEN_TYPES = ("html", "multi_file", "vue_project")


def route_code_gen_type(user_prompt: str) -> str:
    """根据用户需求智能选择代码生成类型。

    模型回复不可靠时回退 html（对齐 Java RouterNode 的兜底逻辑）。

    :param user_prompt: 用户提示词
    :return: html / multi_file / vue_project
    """
    model = create_chat_model(temperature=0)
    response = model.invoke([SystemMessage(load_prompt(_SYSTEM_PROMPT)), HumanMessage(user_prompt)])
    text = str(response.content or "").lower()
    for code_type in CODE_GEN_TYPES:
        if code_type in text:
            return code_type
    return "html"
