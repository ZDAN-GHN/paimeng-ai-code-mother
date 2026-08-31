"""工作区沙箱校验与原子写入（§1.2 / §1.5）。"""

import shutil
import tempfile
from pathlib import Path

from app.config import get_settings


def validate_workspace_path(workspace_path: str) -> Path:
    """校验工作区绝对路径位于 WORKSPACE_ROOT 之下（防路径穿越）。

    :param workspace_path: Java 传入的工作区绝对路径
    :return: 规范化后的路径
    :raises ValueError: 路径为空、非绝对路径或不在 WORKSPACE_ROOT 之下
    """
    if not workspace_path or not Path(workspace_path).is_absolute():
        raise ValueError("workspacePath 必须是绝对路径")
    settings = get_settings()
    root = settings.workspace_root.resolve()
    candidate = Path(workspace_path).resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError(f"workspacePath 必须位于 WORKSPACE_ROOT 之下: {root}")
    return candidate


def atomic_write_files(workspace_path: Path, files: dict[str, str]) -> Path:
    """把文件集写入工作区：临时子目录 → 全部完成后原子 move 到 workspacePath 根。

    失败时清理临时目录并恢复旧目录，不污染目标工作区（§1.5）。

    :param workspace_path: 目标工作区目录（已通过沙箱校验）
    :param files: 相对路径 -> 文件内容
    :return: 目标工作区路径
    :raises OSError: 写入失败
    """
    parent = workspace_path.parent
    parent.mkdir(parents=True, exist_ok=True)
    backup = workspace_path.with_name(workspace_path.name + ".bak")
    with tempfile.TemporaryDirectory(dir=parent, prefix=".stage-") as tmp:
        stage = Path(tmp)
        for rel_path, content in files.items():
            target = stage / rel_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        # 目标工作区整体替换：先备份旧目录，再原子 move
        if workspace_path.exists():
            if backup.exists():
                shutil.rmtree(backup)
            workspace_path.rename(backup)
        try:
            stage.rename(workspace_path)
        except OSError:
            # 替换失败则回滚旧目录，保证不丢已有产物
            if backup.exists() and not workspace_path.exists():
                backup.rename(workspace_path)
            raise
        if backup.exists():
            shutil.rmtree(backup)
    return workspace_path


def write_generated_code(workspace_path: str, code_gen_type: str, output_text: str) -> Path:
    """解析生成结果并原子写入工作区（T10 集成入口）。

    html/multi_file 模式把 LLM 流式产出解析为文件集后落盘；
    vue_project 模式由文件工具直接建项目，此处不适用。

    :param workspace_path: 工作区绝对路径
    :param code_gen_type: 代码生成类型（html / multi_file）
    :param output_text: LLM 生成的代码文本
    :return: 目标工作区路径
    :raises ValueError: 路径不合法或类型不支持
    :raises OSError: 写入失败
    """
    from app.services.codegen.parsing import parse_html_code, parse_multi_file_code, to_files

    validated = validate_workspace_path(workspace_path)
    if code_gen_type == "html":
        files = to_files(parse_html_code(output_text))
    elif code_gen_type == "multi_file":
        files = to_files(parse_multi_file_code(output_text))
    else:
        raise ValueError(f"write_generated_code 不支持的类型: {code_gen_type}")
    return atomic_write_files(validated, files)
