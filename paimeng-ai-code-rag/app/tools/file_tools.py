"""文件类工具（写/读/改/删/列目录/退出），含工作区沙箱校验。

迁移自 Java `ai/tools/ProjectFileWriteTool` 等（docs/py_agent/task_plan.md §3）。
所有相对路径解析到绑定工作区内，禁止越界；返回语义与旧 Java 工具逐条对齐。
"""

from pathlib import Path

from app.workspace.manager import validate_workspace_path

# 需要忽略的文件和目录（对齐 Java ProjectFileDirReadTool）
IGNORED_NAMES = {
    "node_modules", ".git", "dist", "build", ".DS_Store",
    ".env", "target", ".mvn", ".idea", ".vscode", "coverage",
}

# 需要忽略的文件扩展名
IGNORED_EXTENSIONS = (".log", ".tmp", ".cache", ".lock")

# 不允许删除的重要文件（对齐 Java ProjectFileDeleteTool，不区分大小写）
IMPORTANT_FILES = {
    "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "vite.config.js", "vite.config.ts", "vue.config.js",
    "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json",
    "index.html", "main.js", "main.ts", "app.vue", ".gitignore", "readme.md",
}


class FileTools:
    """文件工具集，绑定到当前请求的工作区。

    构造时再次校验工作区位于 WORKSPACE_ROOT 之下（§1.2 沙箱校验）。
    """

    def __init__(self, workspace_path: Path | str) -> None:
        """绑定工作区。

        :param workspace_path: 请求传入的工作区绝对路径（须位于 WORKSPACE_ROOT 之下）
        """
        self._root = validate_workspace_path(str(workspace_path))

    def _resolve(self, relative_path: str) -> Path:
        """把相对路径解析到工作区内，防路径穿越（.. / 绝对路径）。

        :param relative_path: 文件或目录相对路径
        :return: 解析后的绝对路径
        :raises ValueError: 路径为空或解析后越界
        """
        if not relative_path:
            raise ValueError("路径不能为空")
        candidate = (self._root / relative_path).resolve()
        if candidate != self._root and self._root not in candidate.parents:
            raise ValueError(f"路径越界: {relative_path}")
        return candidate

    def write_file(self, relative_file_path: str, content: str) -> str:
        """写入文件到指定路径（自动创建父目录）。

        :param relative_file_path: 文件的相对路径
        :param content: 要写入文件的内容
        :return: 写入结果文本
        """
        path = self._resolve(relative_file_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return f"文件写入成功：{relative_file_path}"

    def read_file(self, relative_file_path: str) -> str:
        """读取指定路径的文件内容。

        :param relative_file_path: 文件的相对路径
        :return: 文件内容或错误信息
        """
        path = self._resolve(relative_file_path)
        if not path.exists() or not path.is_file():
            return f"错误：文件不存在或不是文件 - {relative_file_path}"
        return path.read_text(encoding="utf-8")

    def modify_file(self, relative_file_path: str, old_content: str, new_content: str) -> str:
        """修改文件内容，用新内容替换指定的旧内容。

        :param relative_file_path: 文件的相对路径
        :param old_content: 要替换的旧内容
        :param new_content: 替换后的新内容
        :return: 修改结果文本
        """
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
        """删除指定路径的文件（重要文件受保护）。

        :param relative_file_path: 文件的相对路径
        :return: 删除结果文本
        """
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
        """读取目录结构（忽略构建产物等目录，按深度缩进展示）。

        :param relative_dir_path: 目录的相对路径，为空则读取整个项目结构
        :return: 目录结构文本
        """
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
        """退出工具调用（AI 自主结束任务）。"""
        return "不要继续调用工具，可以输出最终结果了"


def _should_ignore(file_name: str) -> bool:
    """判断是否应忽略该文件。"""
    if file_name in IGNORED_NAMES:
        return True
    return any(file_name.endswith(ext) for ext in IGNORED_EXTENSIONS)
