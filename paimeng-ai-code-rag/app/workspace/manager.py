

import shutil
import tempfile
from pathlib import Path

from app.core.config import get_settings


def validate_workspace_path(workspace_path: str) -> Path:

    if not workspace_path or not Path(workspace_path).is_absolute():
        raise ValueError("workspacePath 必须是绝对路径")
    settings = get_settings()
    root = settings.workspace_root.resolve()
    candidate = Path(workspace_path).resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError(f"workspacePath 必须位于 WORKSPACE_ROOT 之下: {root}")
    return candidate


def atomic_write_files(workspace_path: Path, files: dict[str, str]) -> Path:

    parent = workspace_path.parent
    parent.mkdir(parents=True, exist_ok=True)
    backup = workspace_path.with_name(workspace_path.name + ".bak")
    with tempfile.TemporaryDirectory(dir=parent, prefix=".stage-") as tmp:
        stage = Path(tmp)
        for rel_path, content in files.items():
            target = stage / rel_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")

        if workspace_path.exists():
            if backup.exists():
                shutil.rmtree(backup)
            workspace_path.rename(backup)
        try:
            stage.rename(workspace_path)
        except OSError:

            if backup.exists() and not workspace_path.exists():
                backup.rename(workspace_path)
            raise
        if backup.exists():
            shutil.rmtree(backup)
    return workspace_path


def write_generated_code(workspace_path: str, code_gen_type: str, output_text: str) -> Path:

    from app.services.codegen.parsing import parse_html_code, parse_multi_file_code, to_files

    validated = validate_workspace_path(workspace_path)
    if code_gen_type == "html":
        files = to_files(parse_html_code(output_text))
    elif code_gen_type == "multi_file":
        files = to_files(parse_multi_file_code(output_text))
    else:
        raise ValueError(f"write_generated_code 不支持的类型: {code_gen_type}")
    return atomic_write_files(validated, files)
