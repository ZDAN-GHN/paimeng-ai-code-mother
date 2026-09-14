import shutil
from pathlib import Path
from uuid import uuid4

import pytest

from app.tools.file_tools import FileTools

WORKSPACE_ROOT = "/tmp/paimeng-test-workspace"


@pytest.fixture()
def tools() -> FileTools:

    ws = Path(WORKSPACE_ROOT) / f"ws_{uuid4().hex}"
    ws.mkdir(parents=True)
    yield FileTools(str(ws))
    shutil.rmtree(ws, ignore_errors=True)


@pytest.mark.tool
def test_write_file_creates_parent_dirs(tools):

    result = tools.write_file("src/components/Button.vue", "<template>hi</template>")
    assert result == "文件写入成功：src/components/Button.vue"
    assert (tools._root / "src/components/Button.vue").read_text(
        encoding="utf-8"
    ) == "<template>hi</template>"


@pytest.mark.tool
def test_read_file_roundtrip(tools):

    tools.write_file("a.txt", "hello")
    assert tools.read_file("a.txt") == "hello"


@pytest.mark.tool
def test_read_file_missing_returns_error(tools):

    assert "文件不存在或不是文件" in tools.read_file("missing.txt")


@pytest.mark.tool
def test_modify_file_replaces_content(tools):

    tools.write_file("a.txt", "aaa bbb ccc")
    result = tools.modify_file("a.txt", "bbb", "XXX")
    assert result == "文件修改成功: a.txt"
    assert tools.read_file("a.txt") == "aaa XXX ccc"


@pytest.mark.tool
def test_modify_file_missing_old_content(tools):

    tools.write_file("a.txt", "hello")
    result = tools.modify_file("a.txt", "nope", "XXX")
    assert "未找到要替换的内容" in result
    assert tools.read_file("a.txt") == "hello"


@pytest.mark.tool
def test_delete_file(tools):

    tools.write_file("tmp.txt", "x")
    assert tools.delete_file("tmp.txt") == "文件删除成功: tmp.txt"
    assert not (tools._root / "tmp.txt").exists()


@pytest.mark.tool
def test_delete_important_file_rejected(tools):

    tools.write_file("package.json", "{}")
    result = tools.delete_file("package.json")
    assert "不允许删除重要文件" in result
    assert (tools._root / "package.json").exists()


@pytest.mark.tool
def test_exit_tool(tools):

    assert FileTools.exit_tool() == "不要继续调用工具，可以输出最终结果了"


@pytest.mark.tool
def test_read_dir_structure(tools):

    tools.write_file("index.html", "<h1>a</h1>")
    tools.write_file("assets/style.css", "body{}")
    tools.write_file("node_modules/pkg/index.js", "x")
    tools.write_file("app.log", "log")
    structure = tools.read_dir()
    assert "项目目录结构:" in structure
    assert "index.html" in structure
    assert "style.css" in structure
    assert "node_modules" not in structure
    assert "app.log" not in structure


@pytest.mark.tool
def test_path_traversal_rejected(tools):

    with pytest.raises(ValueError):
        tools.write_file("../escape.txt", "x")


@pytest.mark.tool
def test_absolute_path_outside_rejected(tools):

    with pytest.raises(ValueError):
        tools.read_file("/etc/passwd")
