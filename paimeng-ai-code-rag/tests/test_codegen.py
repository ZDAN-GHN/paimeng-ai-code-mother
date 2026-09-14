import json
from pathlib import Path

import pytest

from app.services.codegen import CodeGenServiceExecutor, CodeGenServiceFactory
from app.services.codegen.parsing import (
    MultiFileCodeResult,
    parse_html_code,
    parse_multi_file_code,
    to_files,
)
from app.services.codegen.routing import route_code_gen_type
from app.services.codegen.vue import VueCodeGenService

WORKSPACE_ROOT = "/tmp/paimeng-test-workspace"


class _FakeResponse:
    def __init__(self, content: str) -> None:
        self.content = content
        self.tool_calls = None


class _FakeModel:
    def __init__(self, content: str) -> None:
        self._content = content

    def invoke(self, messages, **kwargs):
        return _FakeResponse(self._content)


def test_parse_html_code_extracts_block():

    content = "这是说明\n```html\n<h1>hi</h1>\n```\n结尾"
    result = parse_html_code(content)
    assert result.html_code == "<h1>hi</h1>"


def test_parse_html_code_fallback_to_whole():

    result = parse_html_code("  <div>plain</div>  ")
    assert result.html_code == "<div>plain</div>"


def test_parse_multi_file_extracts_three_blocks():

    content = """
```html
<h1>a</h1>
```
```css
body{}
```
```javascript
console.log(1)
```
"""
    result = parse_multi_file_code(content)
    assert result.html_code == "<h1>a</h1>"
    assert result.css_code == "body{}"
    assert result.js_code == "console.log(1)"


def test_parse_multi_file_missing_css():

    result = parse_multi_file_code("```html\n<p>x</p>\n```")
    assert result.css_code == ""
    assert result.html_code == "<p>x</p>"


def test_to_files_html():

    files = to_files(parse_html_code("```html\n<h1>hi</h1>\n```"))
    assert files == {"index.html": "<h1>hi</h1>"}


def test_to_files_multi_file_skips_blank():

    files = to_files(parse_multi_file_code("```html\n<p>x</p>\n```"))
    assert set(files) == {"index.html"}


@pytest.mark.parametrize(
    ("reply", "expected"),
    [
        ("建议使用 HTML", "html"),
        ("VUE_PROJECT 更合适", "vue_project"),
        ("多文件模式 MULTI_FILE", "multi_file"),
        ("看不懂", "html"),
    ],
)
def test_route_code_gen_type(monkeypatch, reply, expected):

    monkeypatch.setattr(
        "app.services.codegen.routing.create_chat_model", lambda **kw: _FakeModel(reply)
    )
    assert route_code_gen_type("做一个页面") == expected


def test_factory_creates_by_type():

    factory = CodeGenServiceFactory()
    assert factory.create("html").__class__.__name__ == "HtmlCodeGenService"
    assert factory.create("multi_file").__class__.__name__ == "MultiFileCodeGenService"
    with pytest.raises(ValueError):
        factory.create("unknown")


def test_executor_stream_html_multi_file_uses_text_stream(monkeypatch):

    import app.services.codegen.html as html_mod
    import app.services.codegen.multi_file as mf_mod

    captured = []

    class _StreamSvc:
        def stream(self, user_message):
            captured.append(user_message)
            yield "chunk1"
            yield "chunk2"

    monkeypatch.setattr(html_mod, "create_chat_model", lambda **kw: object())
    monkeypatch.setattr(mf_mod, "create_chat_model", lambda **kw: object())
    monkeypatch.setattr(
        "app.services.codegen._SERVICE_CLASSES",
        {"html": _StreamSvc, "multi_file": _StreamSvc},
    )

    executor = CodeGenServiceExecutor()
    assert list(executor.stream("html", "msg")) == ["chunk1", "chunk2"]
    assert captured == ["msg"]


def test_vue_tools_binding(tmp_path_factory):

    ws = Path(WORKSPACE_ROOT) / "ws_vue"
    ws.mkdir(parents=True, exist_ok=True)
    from app.tools.file_tools import FileTools

    service = VueCodeGenService(FileTools(str(ws)))
    tools = service._tools()
    names = {getattr(t, "name", "") for t in tools}
    assert names == {
        "writeFile",
        "readFile",
        "modifyFile",
        "deleteFile",
        "readDir",
        "exit",
    }


def test_vue_execute_dispatches(tmp_path_factory):

    ws = Path(WORKSPACE_ROOT) / "ws_vue_exec"
    ws.mkdir(parents=True, exist_ok=True)
    from app.tools.file_tools import FileTools

    service = VueCodeGenService(FileTools(str(ws)))
    result = service._execute(
        "writeFile", {"relativeFilePath": "a.txt", "content": "hello"}
    )
    assert result == "文件写入成功：a.txt"
    assert service._execute("readFile", {"relativeFilePath": "a.txt"}) == "hello"
    assert service._execute("exit", {}) == "不要继续调用工具，可以输出最终结果了"
    assert "不存在的工具" in service._execute("nope", {})
