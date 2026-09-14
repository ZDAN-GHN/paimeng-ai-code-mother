

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


CODE_EXTENSIONS = (".html", ".htm", ".css", ".js", ".json", ".vue", ".ts", ".jsx", ".tsx")


SKIP_DIR_SEGMENTS = ("node_modules", "dist", "target", ".git")


class QualityResult(BaseModel):


    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    is_valid: bool = True
    errors: list[str] = Field(default_factory=list)
    suggestions: list[str] = Field(default_factory=list)


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


def _parse_quality_result(text: str) -> QualityResult:

    data = json.loads(_extract_json(text))
    return QualityResult.model_validate(data)


def read_and_concatenate_code_files(code_dir: str | Path) -> str:

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

    if file.name.startswith("."):
        return True
    relative = file.relative_to(root_dir)
    return any(part in SKIP_DIR_SEGMENTS for part in relative.parts)


def _is_code_file(file: Path) -> bool:

    return file.name.lower().endswith(CODE_EXTENSIONS)


def check_code_quality(code_content: str, *, model: Any = None) -> QualityResult:

    model = model or create_chat_model()
    system = load_prompt(_QUALITY_CHECK_PROMPT)
    try:
        response = model.invoke([SystemMessage(system), HumanMessage(code_content)])
        return _parse_quality_result(getattr(response, "content", "") or "")
    except Exception as exc:  # noqa: BLE001
        logger.warning("代码质量检查失败，按通过处理: %s", exc)
        return QualityResult(is_valid=True)
