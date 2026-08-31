"""LangGraph 代码生成工作流编排（T11）。

对齐 Java `langgraph4j/CodeGenWorkflow`，按 §1.6 职责调整：
- 不含 `project_builder` 节点（构建/部署留在 Java，Python 侧只负责落盘）。
- 图片收集采用「规划 → 顺序执行四类工具」的简化版（并发 fan-out 非本任务必要）。
- guardrail 为 Python 新增入口节点（Java 在 AiServices 层做输入护轨）。

节点链路：guardrail → image_collector → prompt_enhancer → router → code_generator
         → code_quality_check →（质检失败且未超限）回 code_generator /（通过或超限）END。
"""

from typing import Any, Callable, TypedDict

from langgraph.graph import END, START, StateGraph

from app.guardrails import PromptSafetyInputGuardrail
from app.services.codegen import CodeGenServiceExecutor
from app.services.codegen.routing import route_code_gen_type
from app.services.images import ImageTools, plan_image_collection
from app.services.quality import check_code_quality, read_and_concatenate_code_files
from app.tools.file_tools import FileTools
from app.workspace import validate_workspace_path, write_generated_code

# 质检失败后最大重生成次数
MAX_QUALITY_RETRIES = 2

# 图片资源展示类别文案（对齐 Java ImageCategoryEnum.text）
_IMAGE_CATEGORY_TEXT = {
    "CONTENT": "内容图片",
    "ILLUSTRATION": "插画图片",
    "ARCHITECTURE": "架构图",
    "LOGO": "Logo",
}


class CodeGenState(TypedDict, total=False):
    """工作流状态（对齐 Java WorkflowContext 的字段子集）。"""

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
    """代码生成工作流（依赖可注入，便于离线测试）。"""

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
        """构建工作流并绑定依赖。

        :param executor: 代码生成执行器（默认新建）
        :param guardrail: 输入护轨（默认新建）
        :param image_tools: 图片工具集（默认新建）
        :param image_plan: 图片规划函数（默认 plan_image_collection）
        :param quality_check: 质检函数（默认 check_code_quality）
        :param router: 类型路由函数（默认 route_code_gen_type）
        :param max_quality_retries: 质检失败最大重试次数
        """
        self._executor = executor or CodeGenServiceExecutor()
        self._guardrail = guardrail or PromptSafetyInputGuardrail()
        self._image_tools = image_tools or ImageTools()
        self._image_plan = image_plan
        self._quality_check = quality_check
        self._router = router
        self._max_quality_retries = max_quality_retries

    # ---------- 节点 ----------

    def _guardrail_node(self, state: CodeGenState) -> dict[str, Any]:
        """输入安全检查：拒绝时设置 error，由条件边路由到 END。"""
        result = self._guardrail.validate(state.get("original_prompt", ""))
        if not result.is_allowed:
            return {"error": result.reason}
        return {}

    def _image_collector_node(self, state: CodeGenState) -> dict[str, Any]:
        """规划并收集图片资源（对齐 Java ImageCollectorNode，失败不阻断流程）。"""
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
        except Exception:  # noqa: BLE001 - 图片收集失败不阻断生成流程
            resources = []
        return {"image_resources": resources}

    def _prompt_enhancer_node(self, state: CodeGenState) -> dict[str, Any]:
        """把图片素材拼接到提示词（对齐 Java PromptEnhancerNode）。"""
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
        """智能路由代码生成类型（对齐 Java RouterNode，失败兜底 html）。"""
        return {"code_gen_type": self._router(state["original_prompt"])}

    def _code_generator_node(self, state: CodeGenState) -> dict[str, Any]:
        """执行代码生成并落盘工作区（对齐 Java CodeGeneratorNode 的 Python 职责）。

        vue_project 经文件工具直接建项目；html/multi_file 收集文本后解析原子落盘。
        """
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
        """对工作区代码做质量检查（对齐 Java CodeQualityCheckNode）。"""
        code = read_and_concatenate_code_files(state["workspace_path"])
        result = self._quality_check(code) if code.strip() else {"is_valid": False}
        quality_result = result if isinstance(result, dict) else result.model_dump(mode="json")
        return {"quality_result": quality_result}

    # ---------- 条件边 ----------

    def _route_after_guardrail(self, state: CodeGenState) -> str:
        """guardrail 结果路由：拒绝 → error；通过 → next。"""
        return "error" if state.get("error") else "next"

    def _route_after_quality(self, state: CodeGenState) -> str:
        """质检结果路由：失败且未超限 → retry；通过或超限 → end。

        `max_quality_retries` 表示初始执行之后的额外重试次数；
        已执行次数 <= 该上限时仍允许重试。
        """
        quality_result = state.get("quality_result") or {}
        attempts = state.get("quality_attempts", 0)
        if not quality_result.get("is_valid", True) and attempts <= self._max_quality_retries:
            return "retry"
        return "end"

    # ---------- 工作流构建与执行 ----------

    def build(self):
        """构建并编译 LangGraph 工作流。"""
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
        """同步执行工作流，返回最终状态。

        :param state: 初始状态（至少含 original_prompt 与 workspace_path）
        :return: 最终状态
        """
        return self.build().invoke(dict(state))
