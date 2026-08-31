"""图片采集与规划服务（对齐 Java langgraph4j/ai 图片服务与图片类工具）。

包含三部分：
- 图片数据模型（ImageResource / ImageCollectionPlan）
- 规划服务 plan_image_collection：根据用户提示词产出图片收集计划（对齐 ImageCollectionPlanService）
- 采集服务 collect_images：模型自主调用图片工具收集资源（对齐 ImageCollectionService）
- 图片类工具 ImageTools：内容搜索（Pexels）、插画搜索（Undraw）、Logo 生成（DashScope）、架构图生成（Mermaid）
"""

import json
import logging
import re
import subprocess
import tempfile
from enum import StrEnum
from pathlib import Path
from typing import Any

import httpx
from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool as langchain_tool
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from app.config import get_settings
from app.services.llm import create_chat_model, load_prompt

logger = logging.getLogger(__name__)

_IMAGE_PLAN_PROMPT = "image-collection-plan-system-prompt.txt"
_IMAGE_COLLECTION_PROMPT = "image-collection-system-prompt.txt"

# 图片工具最大工具调用轮次
MAX_TOOL_CALLS = 20


class ImageCategory(StrEnum):
    """图片类别（对齐 Java ImageCategoryEnum）。"""

    CONTENT = "CONTENT"
    ILLUSTRATION = "ILLUSTRATION"
    ARCHITECTURE = "ARCHITECTURE"
    LOGO = "LOGO"


class ImageResource(BaseModel):
    """图片资源对象（对齐 Java ImageResource）。"""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    category: ImageCategory
    description: str = ""
    url: str


class ImageSearchTask(BaseModel):
    """内容图片搜索任务（对应 ImageSearchTool.searchContentImages）。"""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    query: str


class IllustrationTask(BaseModel):
    """插画图片搜索任务（对应 UndrawIllustrationTool.searchIllustrations）。"""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    query: str


class DiagramTask(BaseModel):
    """架构图生成任务（对应 MermaidDiagramTool.generateMermaidDiagram）。"""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    mermaid_code: str
    description: str = ""


class LogoTask(BaseModel):
    """Logo 生成任务（对应 LogoGeneratorTool.generateLogos）。"""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    description: str


class ImageCollectionPlan(BaseModel):
    """图片搜集计划（对齐 Java ImageCollectionPlan，字段名与提示词 JSON 对齐）。"""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    content_image_tasks: list[ImageSearchTask] = Field(default_factory=list)
    illustration_tasks: list[IllustrationTask] = Field(default_factory=list)
    diagram_tasks: list[DiagramTask] = Field(default_factory=list)
    logo_tasks: list[LogoTask] = Field(default_factory=list)


def _extract_json(text: str) -> str:
    """从模型输出中提取 JSON 文本（去除 ```json 代码块围栏）。"""
    if not text:
        return ""
    content = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", content, re.DOTALL)
    if fence:
        return fence.group(1).strip()
    # 无围栏：尝试截取从第一个 { 到最后一个 } 的片段
    start, end = content.find("{"), content.rfind("}")
    if start != -1 and end > start:
        return content[start : end + 1]
    return content


def _parse_plan(text: str) -> ImageCollectionPlan:
    """解析模型输出为图片收集计划，失败时返回空计划（不阻断流程）。"""
    try:
        data = json.loads(_extract_json(text))
        return ImageCollectionPlan.model_validate(data)
    except Exception as exc:  # noqa: BLE001 - 解析失败不阻断工作流
        logger.warning("图片收集计划解析失败，使用空计划: %s", exc)
        return ImageCollectionPlan()


def plan_image_collection(user_prompt: str, *, model: Any = None) -> ImageCollectionPlan:
    """根据用户提示词制定图片收集计划。

    对齐 Java ImageCollectionPlanService.planImageCollection；
    使用规划提示词驱动模型，返回结构化计划（任务列表按类型拆解）。

    :param user_prompt: 用户需求描述
    :param model: 可注入的模型（测试用），默认 create_chat_model()
    :return: 图片收集计划
    """
    model = model or create_chat_model()
    system = load_prompt(_IMAGE_PLAN_PROMPT)
    response = model.invoke([SystemMessage(system), HumanMessage(user_prompt)])
    return _parse_plan(getattr(response, "content", "") or "")


class ImageTools:
    """图片类工具集（对齐 Java langgraph4j/tools 的四个图片工具）。

    绑定配置与 HTTP 客户端，工具方法可被 LangChain bind_tools 使用。
    """

    # Pexels 内容图片搜索接口
    PEXELS_API_URL = "https://api.pexels.com/v1/search"
    # Undraw 插画搜索接口
    UNDRAW_API_URL = (
        "https://undraw.co/_next/data/rxbI0cNBbVhP70ybALHAo/search/{query}.json?term={query}"
    )
    # DashScope 文生图接口
    DASHSCOPE_IMAGE_URL = (
        "https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis"
    )

    def __init__(self, *, settings: Any = None, http_client: httpx.Client | None = None) -> None:
        """绑定配置与可注入的 HTTP 客户端。

        :param settings: 配置对象（测试可注入），默认 get_settings()
        :param http_client: HTTP 客户端（测试可 mock），默认新建
        """
        self._settings = settings or get_settings()
        self._http = http_client or httpx.Client(timeout=15.0)

    # ---------- 底层实现 ----------

    def search_content_images(self, query: str) -> list[dict[str, Any]]:
        """调用 Pexels 搜索内容图片（对齐 Java ImageSearchTool.searchContentImages）。

        :param query: 搜索关键词
        :return: ImageResource 字典列表
        """
        api_key = self._settings.pexels_api_key
        if not api_key:
            logger.warning("未配置 PEXELS_API_KEY，跳过内容图片搜索")
            return []
        try:
            resp = self._http.get(
                self.PEXELS_API_URL,
                params={"query": query, "per_page": 12, "page": 1},
                headers={"Authorization": api_key},
            )
            resp.raise_for_status()
            photos = resp.json().get("photos", [])
            return [
                ImageResource(
                    category=ImageCategory.CONTENT,
                    description=photo.get("alt") or query,
                    url=photo.get("src", {}).get("medium", ""),
                ).model_dump(mode="json")
                for photo in photos
                if photo.get("src", {}).get("medium")
            ]
        except Exception as exc:  # noqa: BLE001 - 外部接口失败不阻断流程
            logger.error("Pexels 搜索失败: %s", exc)
            return []

    def search_illustrations(self, query: str) -> list[dict[str, Any]]:
        """调用 Undraw 搜索插画图片（对齐 Java UndrawIllustrationTool.searchIllustrations）。

        :param query: 搜索关键词
        :return: ImageResource 字典列表
        """
        try:
            resp = self._http.get(self.UNDRAW_API_URL.format(query=query), timeout=10.0)
            resp.raise_for_status()
            page_props = resp.json().get("pageProps") or {}
            initial_results = page_props.get("initialResults") or []
            return [
                ImageResource(
                    category=ImageCategory.ILLUSTRATION,
                    description=item.get("title") or "插画",
                    url=item.get("media", ""),
                ).model_dump(mode="json")
                for item in initial_results[:12]
                if item.get("media")
            ]
        except Exception as exc:  # noqa: BLE001 - 外部接口失败不阻断流程
            logger.error("Undraw 插画搜索失败: %s", exc)
            return []

    def generate_logos(self, description: str) -> list[dict[str, Any]]:
        """调用 DashScope 文生图生成 Logo（对齐 Java LogoGeneratorTool.generateLogos）。

        :param description: Logo 设计描述
        :return: ImageResource 字典列表
        """
        api_key = self._settings.dashscope_api_key
        if not api_key:
            logger.warning("未配置 DASHSCOPE_API_KEY，跳过 Logo 生成")
            return []
        prompt = f"生成 Logo，Logo 中禁止包含任何文字！Logo 介绍：{description}"
        try:
            resp = self._http.post(
                self.DASHSCOPE_IMAGE_URL,
                headers={"Authorization": f"Bearer {api_key}"},
                json={
                    "model": self._settings.image_model,
                    "input": {"prompt": prompt},
                    "parameters": {"size": "512*512", "n": 1},
                },
            )
            resp.raise_for_status()
            results = (resp.json().get("output") or {}).get("results") or []
            return [
                ImageResource(
                    category=ImageCategory.LOGO,
                    description=description,
                    url=item.get("url", ""),
                ).model_dump(mode="json")
                for item in results
                if item.get("url")
            ]
        except Exception as exc:  # noqa: BLE001 - 外部接口失败不阻断流程
            logger.error("Logo 生成失败: %s", exc)
            return []

    def generate_architecture_diagram(self, mermaid_code: str, description: str) -> list[dict[str, Any]]:
        """将 Mermaid 代码转换为架构图图片（对齐 Java MermaidDiagramTool.generateMermaidDiagram）。

        通过本地 mmdc 命令把 Mermaid 代码渲染为 SVG，返回本地文件路径 URL；
        COS 上传属于 Java 云端基建，未迁移（Python 侧以 file:// 本地路径回填）。

        :param mermaid_code: Mermaid 图表代码
        :param description: 架构图描述
        :return: ImageResource 字典列表（失败或代码为空时返回空列表）
        """
        if not mermaid_code:
            return []
        mmdc = "mmdc.cmd" if _is_windows() else "mmdc"
        try:
            with tempfile.TemporaryDirectory() as tmp:
                input_file = Path(tmp) / "mermaid_input.mmd"
                output_file = Path(tmp) / "mermaid_output.svg"
                input_file.write_text(mermaid_code, encoding="utf-8")
                subprocess.run(
                    [mmdc, "-i", str(input_file), "-o", str(output_file), "-b", "transparent"],
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=60,
                )
                if not output_file.exists():
                    logger.warning("mmdc 未生成 SVG 文件")
                    return []
                return [
                    ImageResource(
                        category=ImageCategory.ARCHITECTURE,
                        description=description,
                        url=output_file.resolve().as_uri(),
                    ).model_dump(mode="json")
                ]
        except Exception as exc:  # noqa: BLE001 - 转换失败不阻断流程
            logger.error("Mermaid 架构图生成失败: %s", exc)
            return []

    # ---------- LangChain 工具绑定 ----------

    def tools(self) -> list[Any]:
        """把四个图片工具绑定为 LangChain 工具（工具名对齐 Java @Tool 名称）。"""
        impl = self

        @langchain_tool("searchContentImages")
        def search_content_images(query: str) -> str:
            """搜索内容相关的图片，用于网站内容展示"""
            return json.dumps(impl.search_content_images(query), ensure_ascii=False)

        @langchain_tool("searchIllustrations")
        def search_illustrations(query: str) -> str:
            """搜索插画图片，用于网站美化和装饰"""
            return json.dumps(impl.search_illustrations(query), ensure_ascii=False)

        @langchain_tool("generateArchitectureDiagram")
        def generate_architecture_diagram(mermaid_code: str, description: str) -> str:
            """将 Mermaid 代码转换为架构图图片，用于展示系统结构和技术关系"""
            return json.dumps(
                impl.generate_architecture_diagram(mermaid_code, description), ensure_ascii=False
            )

        @langchain_tool("generateLogos")
        def generate_logos(description: str) -> str:
            """根据描述生成 Logo 设计图片，用于网站品牌标识"""
            return json.dumps(impl.generate_logos(description), ensure_ascii=False)

        return [search_content_images, search_illustrations, generate_architecture_diagram, generate_logos]

    def execute(self, tool_name: str, args: dict[str, Any]) -> str:
        """按名称执行图片工具并返回 JSON 文本（供 collect_images 调用）。

        :param tool_name: 工具名
        :param args: 工具参数
        :return: ImageResource 列表的 JSON 文本
        """
        if tool_name == "searchContentImages":
            result = self.search_content_images(args["query"])
        elif tool_name == "searchIllustrations":
            result = self.search_illustrations(args["query"])
        elif tool_name == "generateArchitectureDiagram":
            result = self.generate_architecture_diagram(args["mermaid_code"], args["description"])
        elif tool_name == "generateLogos":
            result = self.generate_logos(args["description"])
        else:
            return f'错误：不存在的工具 {tool_name}'
        return json.dumps(result, ensure_ascii=False)


def _is_windows() -> bool:
    """判断当前是否 Windows 平台（决定 mmdc 命令名）。"""
    import platform

    return platform.system() == "Windows"


def collect_images(user_prompt: str, *, model: Any = None, image_tools: ImageTools | None = None) -> list[ImageResource]:
    """模型自主调用图片工具收集图片资源。

    对齐 Java ImageCollectionService.collectImages；
    模型根据需求自主选择并调用工具，收集到的资源汇总返回。

    :param user_prompt: 用户需求描述
    :param model: 可注入的模型（测试用），默认 create_chat_model()
    :param image_tools: 可注入的图片工具集，默认新建
    :return: 收集到的图片资源列表
    """
    image_tools = image_tools or ImageTools()
    model = (model or create_chat_model()).bind_tools(image_tools.tools())
    messages = [SystemMessage(load_prompt(_IMAGE_COLLECTION_PROMPT)), HumanMessage(user_prompt)]
    collected: list[ImageResource] = []

    for _ in range(MAX_TOOL_CALLS):
        response = model.invoke(messages)
        messages.append(response)
        tool_calls = getattr(response, "tool_calls", None) or []
        if not tool_calls:
            break
        for tool_call in tool_calls:
            name = tool_call["name"]
            result_text = image_tools.execute(name, tool_call.get("args", {}))
            try:
                items = json.loads(result_text)
                collected.extend(ImageResource.model_validate(item) for item in items if isinstance(item, dict))
            except Exception as exc:  # noqa: BLE001 - 单条工具结果解析失败不阻断
                logger.warning("图片工具结果解析失败: %s", exc)
            messages.append(ToolMessage(result_text, tool_call_id=tool_call["id"]))
    return collected
