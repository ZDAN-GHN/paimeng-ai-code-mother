

from typing import Any, Callable, TypedDict

from langgraph.graph import END, START, StateGraph

from app.core.guardrails import PromptSafetyInputGuardrail
from app.services.codegen import CodeGenServiceExecutor
from app.services.codegen.routing import route_code_gen_type
from app.services.images import ImageTools, plan_image_collection
from app.services.quality import check_code_quality, read_and_concatenate_code_files
from app.tools.file_tools import FileTools
from app.workspace.manager import validate_workspace_path, write_generated_code


MAX_QUALITY_RETRIES = 2


_IMAGE_CATEGORY_TEXT = {
    "CONTENT": "内容图片",
    "ILLUSTRATION": "插画图片",
    "ARCHITECTURE": "架构图",
    "LOGO": "Logo",
}


class CodeGenState(TypedDict, total=False):


    original_prompt: str
    enhanced_prompt: str
    code_gen_type: str
    image_resources: list[dict[str, Any]]
    generated_text: str
    events: list[dict[str, Any]]
    workspace_path: str
    quality_result: dict[str, Any]
    quality_attempts: int
    error: str


class CodeGenWorkflow:


    def __init__(
        self,
        *,
        executor: CodeGenServiceExecutor | None = None,
        guardrail: PromptSafetyInputGuardrail | None = None,
        image_tools: ImageTools | None = None,
        image_plan: Callable[[str], Any] = plan_image_collection,
        quality_check: Callable[[str], Any] = check_code_quality,
        router: Callable[[str], str] = route_code_gen_type,
        max_quality_retries: int = MAX_QUALITY_RETRIES,
    ) -> None:

        self._executor = executor or CodeGenServiceExecutor()
        self._guardrail = guardrail or PromptSafetyInputGuardrail()
        self._image_tools = image_tools or ImageTools()
        self._image_plan = image_plan
        self._quality_check = quality_check
        self._router = router
        self._max_quality_retries = max_quality_retries



    def _guardrail_node(self, state: CodeGenState) -> dict[str, Any]:

        result = self._guardrail.validate(state.get("original_prompt", ""))
        if not result.is_allowed:
            return {"error": result.reason}
        return {}

    def _image_collector_node(self, state: CodeGenState) -> dict[str, Any]:

        resources: list[dict[str, Any]] = []
        try:
            plan = self._image_plan(state["original_prompt"])
            for task in plan.content_image_tasks:
                resources.extend(self._image_tools.search_content_images(task.query))
            for task in plan.illustration_tasks:
                resources.extend(self._image_tools.search_illustrations(task.query))
            for task in plan.diagram_tasks:
                resources.extend(self._image_tools.generate_architecture_diagram(task.mermaid_code, task.description))
            for task in plan.logo_tasks:
                resources.extend(self._image_tools.generate_logos(task.description))
        except Exception:  # noqa: BLE001
            resources = []
        return {"image_resources": resources}

    def _prompt_enhancer_node(self, state: CodeGenState) -> dict[str, Any]:

        enhanced = state["original_prompt"]
        resources = state.get("image_resources") or []
        if resources:
            lines = [
                "",
                "## 可用素材资源",
                "请在生成网站使用以下图片资源，将这些图片合理地嵌入到网站的相应位置中。",
            ]
            for resource in resources:
                category = _IMAGE_CATEGORY_TEXT.get(resource.get("category", ""), resource.get("category", ""))
                lines.append(f"- {category}：{resource.get('description', '')}（{resource.get('url', '')}）")
            enhanced = f"{enhanced}\n" + "\n".join(lines)
        return {"enhanced_prompt": enhanced}

    def _router_node(self, state: CodeGenState) -> dict[str, Any]:

        return {"code_gen_type": self._router(state["original_prompt"])}

    def _code_generator_node(self, state: CodeGenState) -> dict[str, Any]:

        code_gen_type = state["code_gen_type"]
        workspace = validate_workspace_path(state["workspace_path"])
        file_tools = FileTools(str(workspace)) if code_gen_type == "vue_project" else None
        text_parts: list[str] = []
        events: list[dict[str, Any]] = []
        for item in self._executor.stream(code_gen_type, state["enhanced_prompt"], file_tools):
            if isinstance(item, dict):
                events.append(item)
            else:
                text_parts.append(str(item))
        generated_text = "".join(text_parts)
        if code_gen_type in ("html", "multi_file") and generated_text:
            write_generated_code(str(workspace), code_gen_type, generated_text)
        return {
            "generated_text": generated_text,
            "events": events,
            "quality_attempts": state.get("quality_attempts", 0) + 1,
        }

    def _code_quality_check_node(self, state: CodeGenState) -> dict[str, Any]:

        code = read_and_concatenate_code_files(state["workspace_path"])
        result = self._quality_check(code) if code.strip() else {"is_valid": False}
        quality_result = result if isinstance(result, dict) else result.model_dump(mode="json")
        return {"quality_result": quality_result}



    def _route_after_guardrail(self, state: CodeGenState) -> str:

        return "error" if state.get("error") else "next"

    def _route_after_quality(self, state: CodeGenState) -> str:

        quality_result = state.get("quality_result") or {}
        attempts = state.get("quality_attempts", 0)
        if not quality_result.get("is_valid", True) and attempts <= self._max_quality_retries:
            return "retry"
        return "end"



    def build(self):

        graph = StateGraph(CodeGenState)
        graph.add_node("guardrail", self._guardrail_node)
        graph.add_node("image_collector", self._image_collector_node)
        graph.add_node("prompt_enhancer", self._prompt_enhancer_node)
        graph.add_node("router", self._router_node)
        graph.add_node("code_generator", self._code_generator_node)
        graph.add_node("code_quality_check", self._code_quality_check_node)

        graph.add_edge(START, "guardrail")
        graph.add_conditional_edges(
            "guardrail",
            self._route_after_guardrail,
            {"error": END, "next": "image_collector"},
        )
        graph.add_edge("image_collector", "prompt_enhancer")
        graph.add_edge("prompt_enhancer", "router")
        graph.add_edge("router", "code_generator")
        graph.add_edge("code_generator", "code_quality_check")
        graph.add_conditional_edges(
            "code_quality_check",
            self._route_after_quality,
            {"retry": "code_generator", "end": END},
        )
        return graph.compile()

    def run(self, state: dict[str, Any]) -> dict[str, Any]:

        return self.build().invoke(dict(state))
