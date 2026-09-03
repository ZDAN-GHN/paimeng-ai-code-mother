"""代码生成服务迁移测试（T7）：解析、路由、工厂分发、vue 工具绑定。"""

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
    """模拟 LangChain 模型响应。"""

    def __init__(self, content: str) -> None:
        self.content = content
        self.tool_calls = None


class _FakeModel:
    """模拟 ChatOpenAI。"""

    def __init__(self, content: str) -> None:
        self._content = content

    def invoke(self, messages, **kwargs):
        return _FakeResponse(self._content)


# ---------- 解析 ----------


def test_parse_html_code_extracts_block():
    """提取 ```html 代码块内容。"""
    content = "这是说明\n```html\n<h1>hi</h1>\n```\n结尾"
    result = parse_html_code(content)
    assert result.html_code == "<h1>hi</h1>"


def test_parse_html_code_fallback_to_whole():
    """无代码块时把整个内容作为 HTML。"""
    result = parse_html_code("  <div>plain</div>  ")
    assert result.html_code == "<div>plain</div>"


def test_parse_multi_file_extracts_three_blocks():
    """多文件解析提取 html/css/js 三块。"""
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
    """缺 CSS 代码块时 css_code 为空。"""
    result = parse_multi_file_code("```html\n<p>x</p>\n```")
    assert result.css_code == ""
    assert result.html_code == "<p>x</p>"


def test_to_files_html():
    """HTML 结果转文件集（index.html）。"""
    files = to_files(parse_html_code("```html\n<h1>hi</h1>\n```"))
    assert files == {"index.html": "<h1>hi</h1>"}


def test_to_files_multi_file_skips_blank():
    """多文件结果转文件集（空白内容不写文件）。"""
    files = to_files(parse_multi_file_code("```html\n<p>x</p>\n```"))
    assert set(files) == {"index.html"}


# ---------- 路由（mock 模型） ----------


@pytest.mark.parametrize(
    ("reply", "expected"),
    [
        ("建议使用 HTML", "html"),
        ("VUE_PROJECT 更合适", "vue_project"),
        ("多文件模式 MULTI_FILE", "multi_file"),
        ("看不懂", "html"),  # 兜底
    ],
)
def test_route_code_gen_type(monkeypatch, reply, expected):
    """路由按模型回复选择类型，异常回复兜底 html。"""
    monkeypatch.setattr("app.services.codegen.routing.create_chat_model", lambda **kw: _FakeModel(reply))
    assert route_code_gen_type("做一个页面") == expected


# ---------- 工厂 / 执行器分发 ----------


def test_factory_creates_by_type():
    """工厂按类型创建服务。"""
    factory = CodeGenServiceFactory()
    assert factory.create("html").__class__.__name__ == "HtmlCodeGenService"
    assert factory.create("multi_file").__class__.__name__ == "MultiFileCodeGenService"
    with pytest.raises(ValueError):
        factory.create("unknown")


def test_executor_stream_html_multi_file_uses_text_stream(monkeypatch):
    """html/multi_file 走纯文本流服务。"""
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
    monkeypatch.setattr("app.services.codegen._SERVICE_CLASSES", {"html": _StreamSvc, "multi_file": _StreamSvc})

    executor = CodeGenServiceExecutor()
    assert list(executor.stream("html", "msg")) == ["chunk1", "chunk2"]
    assert captured == ["msg"]


# ---------- vue 工具绑定 ----------


def test_vue_tools_binding(tmp_path_factory):
    """vue 服务把六个文件工具绑定为 LangChain 工具。"""
    ws = Path(WORKSPACE_ROOT) / "ws_vue"
    ws.mkdir(parents=True, exist_ok=True)
    from app.tools.file_tools import FileTools

    service = VueCodeGenService(FileTools(str(ws)))
    tools = service._tools()
    names = {getattr(t, "name", "") for t in tools}
    assert names == {"writeFile", "readFile", "modifyFile", "deleteFile", "readDir", "exit"}


def test_vue_execute_dispatches(tmp_path_factory):
    """vue 工具执行按名称分发到文件工具。"""
    ws = Path(WORKSPACE_ROOT) / "ws_vue_exec"
    ws.mkdir(parents=True, exist_ok=True)
    from app.tools.file_tools import FileTools

    service = VueCodeGenService(FileTools(str(ws)))
    result = service._execute("writeFile", {"relativeFilePath": "a.txt", "content": "hello"})
    assert result == "文件写入成功：a.txt"
    assert service._execute("readFile", {"relativeFilePath": "a.txt"}) == "hello"
    assert service._execute("exit", {}) == "不要继续调用工具，可以输出最终结果了"
    assert "不存在的工具" in service._execute("nope", {})
