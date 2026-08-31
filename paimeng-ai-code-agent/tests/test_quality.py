"""代码质量检查服务迁移测试（T8）：文件拼接与质检解析。"""

from app.services.quality import (
    QualityResult,
    check_code_quality,
    read_and_concatenate_code_files,
)


class _FakeResponse:
    """模拟 LangChain 模型响应。"""

    def __init__(self, content: str) -> None:
        self.content = content


class _FakeModel:
    """模拟 ChatOpenAI。"""

    def __init__(self, content: str) -> None:
        self._content = content

    def invoke(self, messages, **kwargs):
        return _FakeResponse(self._content)


# ---------- 文件拼接 ----------


def test_concatenate_includes_code_and_skips_ignored(tmp_path):
    """只拼接代码文件，跳过隐藏文件与 node_modules 等目录。"""
    root = tmp_path / "ws"
    root.mkdir(parents=True, exist_ok=True)
    (root / "index.html").write_text("<h1>hi</h1>", encoding="utf-8")
    (root / "style.css").write_text("body{}", encoding="utf-8")
    (root / ".hidden").write_text("x", encoding="utf-8")
    (root / "data.txt").write_text("not code", encoding="utf-8")
    node_modules = root / "node_modules" / "lib"
    node_modules.mkdir(parents=True)
    (node_modules / "dep.js").write_text("var x=1", encoding="utf-8")
    dist = root / "dist"
    dist.mkdir(parents=True)
    (dist / "bundle.js").write_text("var y=1", encoding="utf-8")

    content = read_and_concatenate_code_files(root)
    assert "index.html" in content
    assert "<h1>hi</h1>" in content
    assert "body{}" in content
    assert ".hidden" not in content
    assert "data.txt" not in content
    assert "node_modules" not in content
    assert "dist" not in content


def test_concatenate_missing_dir_returns_empty(tmp_path):
    """目录不存在时返回空字符串。"""
    assert read_and_concatenate_code_files(tmp_path / "nope") == ""


# ---------- 质检 ----------


def test_check_quality_parses_json(monkeypatch):
    """质检 JSON 解析为 QualityResult。"""
    payload = """```json
{"isValid": false, "errors": ["缺少闭合标签"], "suggestions": ["补全标签"]}
```"""
    monkeypatch.setattr("app.services.quality.create_chat_model", lambda **kw: _FakeModel(payload))
    result = check_code_quality("<div>")
    assert result.is_valid is False
    assert result.errors == ["缺少闭合标签"]
    assert result.suggestions == ["补全标签"]


def test_check_quality_fallback_pass_on_error(monkeypatch):
    """质检异常时按通过处理（不阻断工作流）。"""
    monkeypatch.setattr("app.services.quality.create_chat_model", lambda **kw: _FakeModel("垃圾输出"))
    result = check_code_quality("<div>")
    assert result.is_valid is True
    assert result == QualityResult(is_valid=True)
