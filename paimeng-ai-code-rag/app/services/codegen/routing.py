from langchain_core.messages import HumanMessage, SystemMessage

from app.services.llm import create_chat_model, load_prompt

_SYSTEM_PROMPT = "codegen-routing-system-prompt.txt"
CODE_GEN_TYPES = ("html", "multi_file", "vue_project")


def route_code_gen_type(user_prompt: str) -> str:

    model = create_chat_model(temperature=0)
    response = model.invoke(
        [SystemMessage(load_prompt(_SYSTEM_PROMPT)), HumanMessage(user_prompt)]
    )
    text = str(response.content or "").lower()
    for code_type in CODE_GEN_TYPES:
        if code_type in text:
            return code_type
    return "html"
