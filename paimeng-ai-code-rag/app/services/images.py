

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

from app.core.config import get_settings
from app.services.llm import create_chat_model, load_prompt

logger = logging.getLogger(__name__)

_IMAGE_PLAN_PROMPT = "image-collection-plan-system-prompt.txt"
_IMAGE_COLLECTION_PROMPT = "image-collection-system-prompt.txt"


MAX_TOOL_CALLS = 20


class ImageCategory(StrEnum):


    CONTENT = "CONTENT"
    ILLUSTRATION = "ILLUSTRATION"
    ARCHITECTURE = "ARCHITECTURE"
    LOGO = "LOGO"


class ImageResource(BaseModel):


    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    category: ImageCategory
    description: str = ""
    url: str


class ImageSearchTask(BaseModel):


    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    query: str


class IllustrationTask(BaseModel):


    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    query: str


class DiagramTask(BaseModel):


    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    mermaid_code: str
    description: str = ""


class LogoTask(BaseModel):


    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    description: str


class ImageCollectionPlan(BaseModel):


    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    content_image_tasks: list[ImageSearchTask] = Field(default_factory=list)
    illustration_tasks: list[IllustrationTask] = Field(default_factory=list)
    diagram_tasks: list[DiagramTask] = Field(default_factory=list)
    logo_tasks: list[LogoTask] = Field(default_factory=list)


def _extract_json(text: str) -> str:

    if not text:
        return ""
    content = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", content, re.DOTALL)
    if fence:
        return fence.group(1).strip()

    start, end = content.find("{"), content.rfind("}")
    if start != -1 and end > start:
        return content[start : end + 1]
    return content


def _parse_plan(text: str) -> ImageCollectionPlan:

    try:
        data = json.loads(_extract_json(text))
        return ImageCollectionPlan.model_validate(data)
    except Exception as exc:  # noqa: BLE001
        logger.warning("图片收集计划解析失败，使用空计划: %s", exc)
        return ImageCollectionPlan()


def plan_image_collection(user_prompt: str, *, model: Any = None) -> ImageCollectionPlan:

    model = model or create_chat_model()
    system = load_prompt(_IMAGE_PLAN_PROMPT)
    response = model.invoke([SystemMessage(system), HumanMessage(user_prompt)])
    return _parse_plan(getattr(response, "content", "") or "")


class ImageTools:



    PEXELS_API_URL = "https://api.pexels.com/v1/search"

    UNDRAW_API_URL = (
        "https://undraw.co/_next/data/rxbI0cNBbVhP70ybALHAo/search/{query}.json?term={query}"
    )

    DASHSCOPE_IMAGE_URL = (
        "https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis"
    )

    def __init__(self, *, settings: Any = None, http_client: httpx.Client | None = None) -> None:

        self._settings = settings or get_settings()
        self._http = http_client or httpx.Client(timeout=15.0)



    def search_content_images(self, query: str) -> list[dict[str, Any]]:

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
        except Exception as exc:  # noqa: BLE001
            logger.error("Pexels 搜索失败: %s", exc)
            return []

    def search_illustrations(self, query: str) -> list[dict[str, Any]]:

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
        except Exception as exc:  # noqa: BLE001
            logger.error("Undraw 插画搜索失败: %s", exc)
            return []

    def generate_logos(self, description: str) -> list[dict[str, Any]]:

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
        except Exception as exc:  # noqa: BLE001
            logger.error("Logo 生成失败: %s", exc)
            return []

    def generate_architecture_diagram(self, mermaid_code: str, description: str) -> list[dict[str, Any]]:

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
        except Exception as exc:  # noqa: BLE001
            logger.error("Mermaid 架构图生成失败: %s", exc)
            return []



    def tools(self) -> list[Any]:

        impl = self

        @langchain_tool("searchContentImages")
        def search_content_images(query: str) -> str:

            return json.dumps(impl.search_content_images(query), ensure_ascii=False)

        @langchain_tool("searchIllustrations")
        def search_illustrations(query: str) -> str:

            return json.dumps(impl.search_illustrations(query), ensure_ascii=False)

        @langchain_tool("generateArchitectureDiagram")
        def generate_architecture_diagram(mermaid_code: str, description: str) -> str:

            return json.dumps(
                impl.generate_architecture_diagram(mermaid_code, description), ensure_ascii=False
            )

        @langchain_tool("generateLogos")
        def generate_logos(description: str) -> str:

            return json.dumps(impl.generate_logos(description), ensure_ascii=False)

        return [search_content_images, search_illustrations, generate_architecture_diagram, generate_logos]

    def execute(self, tool_name: str, args: dict[str, Any]) -> str:

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

    import platform

    return platform.system() == "Windows"


def collect_images(user_prompt: str, *, model: Any = None, image_tools: ImageTools | None = None) -> list[ImageResource]:

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
            except Exception as exc:  # noqa: BLE001
                logger.warning("图片工具结果解析失败: %s", exc)
            messages.append(ToolMessage(result_text, tool_call_id=tool_call["id"]))
    return collected
