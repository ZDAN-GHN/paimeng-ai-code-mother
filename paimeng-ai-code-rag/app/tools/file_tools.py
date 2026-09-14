

from pathlib import Path

from app.workspace.manager import validate_workspace_path


IGNORED_NAMES = {
    "node_modules", ".git", "dist", "build", ".DS_Store",
    ".env", "target", ".mvn", ".idea", ".vscode", "coverage",
}


IGNORED_EXTENSIONS = (".log", ".tmp", ".cache", ".lock")


IMPORTANT_FILES = {
    "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "vite.config.js", "vite.config.ts", "vue.config.js",
    "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json",
    "index.html", "main.js", "main.ts", "app.vue", ".gitignore", "readme.md",
}


class FileTools:


    def __init__(self, workspace_path: Path | str) -> None:

        self._root = validate_workspace_path(str(workspace_path))

    def _resolve(self, relative_path: str) -> Path:

        if not relative_path:
            raise ValueError("路径不能为空")
        candidate = (self._root / relative_path).resolve()
        if candidate != self._root and self._root not in candidate.parents:
            raise ValueError(f"路径越界: {relative_path}")
        return candidate

    def write_file(self, relative_file_path: str, content: str) -> str:

        path = self._resolve(relative_file_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return f"文件写入成功：{relative_file_path}"

    def read_file(self, relative_file_path: str) -> str:

        path = self._resolve(relative_file_path)
        if not path.exists() or not path.is_file():
            return f"错误：文件不存在或不是文件 - {relative_file_path}"
        return path.read_text(encoding="utf-8")

    def modify_file(self, relative_file_path: str, old_content: str, new_content: str) -> str:

        path = self._resolve(relative_file_path)
        if not path.exists() or not path.is_file():
            return f"错误：文件不存在或不是文件 - {relative_file_path}"
        original_content = path.read_text(encoding="utf-8")
        if old_content not in original_content:
            return f"警告：文件中未找到要替换的内容，文件未修改 - {relative_file_path}"
        modified_content = original_content.replace(old_content, new_content)
        if modified_content == original_content:
            return f"信息：替换后文件内容未发生变化 - {relative_file_path}"
        path.write_text(modified_content, encoding="utf-8")
        return f"文件修改成功: {relative_file_path}"

    def delete_file(self, relative_file_path: str) -> str:

        path = self._resolve(relative_file_path)
        if not path.exists():
            return f"警告：文件不存在，无需删除 - {relative_file_path}"
        if not path.is_file():
            return f"错误：指定路径不是文件，无法删除 - {relative_file_path}"
        if path.name.lower() in IMPORTANT_FILES:
            return f"错误：不允许删除重要文件 - {path.name}"
        path.unlink()
        return f"文件删除成功: {relative_file_path}"

    def read_dir(self, relative_dir_path: str | None = None) -> str:

        rel = relative_dir_path or ""
        root = self._resolve(rel) if rel else self._root
        if not root.exists() or not root.is_dir():
            return f"错误：目录不存在或不是目录 - {rel}"

        files: list[Path] = []
        for path in root.rglob("*"):
            if path.is_dir():
                continue
            if _should_ignore(path.name):
                continue
            files.append(path)

        def sort_key(path: Path) -> tuple[int, str]:
            depth = len(path.relative_to(root).parts) - 1
            return depth, str(path)

        lines = ["项目目录结构:"]
        for path in sorted(files, key=sort_key):
            depth = len(path.relative_to(root).parts) - 1
            lines.append("  " * depth + path.name)
        return "\n".join(lines)

    @staticmethod
    def exit_tool() -> str:

        return "不要继续调用工具，可以输出最终结果了"


def _should_ignore(file_name: str) -> bool:

    if file_name in IGNORED_NAMES:
        return True
    return any(file_name.endswith(ext) for ext in IGNORED_EXTENSIONS)
