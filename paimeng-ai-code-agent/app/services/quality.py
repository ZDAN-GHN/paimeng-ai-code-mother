"""代码质量检查服务（对齐 Java langgraph4j/ai/CodeQualityCheckService 与 CodeQualityCheckNode）。

包含两部分：
- 代码文件读取拼接 read_and_concatenate_code_files（对齐节点私有方法，供工作流质检节点使用）
- 质量检查 check_code_quality（对齐服务，AI 分析代码返回 QualityResult）
"""

import json
import logging
import re
from pathlib import Path
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from app.services.llm import create_chat_model, load_prompt

logger = logging.getLogger(__name__)

_QUALITY_CHECK_PROMPT = "code-quality-check-system-prompt.txt"

# 需要检查的代码文件扩展名（对齐 Java CodeQualityCheckNode.CODE_EXTENSIONS）
CODE_EXTENSIONS = (".html", ".htm", ".css", ".js", ".json", ".vue", ".ts", ".jsx", ".tsx")

# 需要跳过的目录片段（对齐 Java CodeQualityCheckNode.shouldSkipFile）
SKIP_DIR_SEGMENTS = ("node_modules", "dist", "target", ".git")


class QualityResult(BaseModel):
    """质量检查结果（对齐 Java QualityResult）。"""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    is_valid: bool = True
    errors: list[str] = Field(default_factory=list)
    suggestions: list[str] = Field(default_factory=list)


def _extract_json(text: str) -> str:
    """从模型输出中提取 JSON 文本（去除 ```json 代码块围栏）。"""
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


def _parse_quality_result(text: str) -> QualityResult:
    """解析模型输出为质量检查结果，解析失败抛 ValueError（由调用方兜底）。"""
    data = json.loads(_extract_json(text))
    return QualityResult.model_validate(data)


def read_and_concatenate_code_files(code_dir: str | Path) -> str:
    """读取并拼接代码目录下的所有代码文件内容。

    对齐 Java CodeQualityCheckNode.readAndConcatenateCodeFiles：
    跳过隐藏文件、node_modules/dist/target/.git 目录与非代码扩展名文件；
    输出以「# 项目文件结构和代码内容」为头，每个文件以「## 文件: <相对路径>」分隔。

    :param code_dir: 代码目录
    :return: 拼接后的代码内容（目录不存在或为空时返回空字符串）
    """
    directory = Path(code_dir)
    if not directory.is_dir():
        logger.error("代码目录不存在或不是目录: %s", code_dir)
        return ""
    lines = ["# 项目文件结构和代码内容", ""]
    for file in sorted(directory.rglob("*")):
        if not file.is_file():
            continue
        if _should_skip_file(file, directory):
            continue
        if not _is_code_file(file):
            continue
        relative_path = file.relative_to(directory).as_posix()
        lines.append(f"## 文件: {relative_path}")
        lines.append("")
        lines.append(file.read_text(encoding="utf-8", errors="replace"))
        lines.append("")
    return "\n".join(lines)


def _should_skip_file(file: Path, root_dir: Path) -> bool:
    """判断是否应跳过此文件（隐藏文件与忽略目录）。"""
    if file.name.startswith("."):
        return True
    relative = file.relative_to(root_dir)
    return any(part in SKIP_DIR_SEGMENTS for part in relative.parts)


def _is_code_file(file: Path) -> bool:
    """判断是否为需要检查的代码文件。"""
    return file.name.lower().endswith(CODE_EXTENSIONS)


def check_code_quality(code_content: str, *, model: Any = None) -> QualityResult:
    """调用 AI 分析代码并返回质量检查结果。

    对齐 Java CodeQualityCheckService.checkCodeQuality；
    解析失败或调用异常时返回通过结果（is_valid=true），不阻断工作流后续步骤。

    :param code_content: 待检查的代码内容
    :param model: 可注入的模型（测试用），默认 create_chat_model()
    :return: 质量检查结果
    """
    model = model or create_chat_model()
    system = load_prompt(_QUALITY_CHECK_PROMPT)
    try:
        response = model.invoke([SystemMessage(system), HumanMessage(code_content)])
        return _parse_quality_result(getattr(response, "content", "") or "")
    except Exception as exc:  # noqa: BLE001 - 质检失败不阻断工作流
        logger.warning("代码质量检查失败，按通过处理: %s", exc)
        return QualityResult(is_valid=True)
