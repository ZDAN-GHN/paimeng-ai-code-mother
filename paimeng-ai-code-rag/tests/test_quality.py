

from app.services.quality import (
    QualityResult,
    check_code_quality,
    read_and_concatenate_code_files,
)


class _FakeResponse:


    def __init__(self, content: str) -> None:
        self.content = content


class _FakeModel:


    def __init__(self, content: str) -> None:
        self._content = content

    def invoke(self, messages, **kwargs):
        return _FakeResponse(self._content)





def test_concatenate_includes_code_and_skips_ignored(tmp_path):

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

    assert read_and_concatenate_code_files(tmp_path / "nope") == ""





def test_check_quality_parses_json(monkeypatch):

    payload = """```json
{"isValid": false, "errors": ["缺少闭合标签"], "suggestions": ["补全标签"]}
```"""
    monkeypatch.setattr("app.services.quality.create_chat_model", lambda **kw: _FakeModel(payload))
    result = check_code_quality("<div>")
    assert result.is_valid is False
    assert result.errors == ["缺少闭合标签"]
    assert result.suggestions == ["补全标签"]


def test_check_quality_fallback_pass_on_error(monkeypatch):

    monkeypatch.setattr("app.services.quality.create_chat_model", lambda **kw: _FakeModel("垃圾输出"))
    result = check_code_quality("<div>")
    assert result.is_valid is True
    assert result == QualityResult(is_valid=True)
