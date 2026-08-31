"""工作区沙箱校验与原子写入测试（§1.2 / §1.5 / T10 集成）。"""

import pytest

from app.workspace import atomic_write_files, validate_workspace_path, write_generated_code

WORKSPACE_ROOT = "/tmp/paimeng-test-workspace"


@pytest.mark.workspace
def test_validate_accepts_path_under_root():
    """WORKSPACE_ROOT 之下的绝对路径通过校验。"""
    assert validate_workspace_path(f"{WORKSPACE_ROOT}/html_1") is not None


@pytest.mark.workspace
def test_validate_rejects_relative_path():
    """相对路径被拒绝。"""
    with pytest.raises(ValueError):
        validate_workspace_path("html_1")


@pytest.mark.workspace
def test_validate_rejects_path_outside_root():
    """越界路径（路径穿越）被拒绝。"""
    with pytest.raises(ValueError):
        validate_workspace_path("/etc/passwd")


@pytest.mark.workspace
def test_atomic_write_replaces_workspace():
    """原子写入：新文件集整体替换旧目录，临时目录不残留。"""
    target = validate_workspace_path(f"{WORKSPACE_ROOT}/html_atomic_test")
    atomic_write_files(target, {"index.html": "<h1>old</h1>"})

    # 第二次写入应整体替换，不残留旧文件
    atomic_write_files(target, {"new.html": "<h1>new</h1>"})
    assert not (target / "index.html").exists()
    assert (target / "new.html").read_text(encoding="utf-8") == "<h1>new</h1>"

    # 无 .stage- / .bak 临时目录残留
    leftovers = [p.name for p in target.parent.iterdir() if p.name.startswith((".stage-", "html_atomic_test.bak"))]
    assert leftovers == []


@pytest.mark.workspace
def test_write_generated_code_html():
    """T10 集成：html 生成结果解析并原子写入 index.html。"""
    target = write_generated_code(f"{WORKSPACE_ROOT}/html_gen_test", "html", "说明\n```html\n<h1>hi</h1>\n```")
    assert (target / "index.html").read_text(encoding="utf-8") == "<h1>hi</h1>"


@pytest.mark.workspace
def test_write_generated_code_multi_file():
    """T10 集成：multi_file 生成结果解析为三文件并原子写入。"""
    content = "```html\n<h1>a</h1>\n```\n```css\nbody{}\n```\n```javascript\nconsole.log(1)\n```"
    target = write_generated_code(f"{WORKSPACE_ROOT}/mf_gen_test", "multi_file", content)
    assert (target / "index.html").read_text(encoding="utf-8") == "<h1>a</h1>"
    assert (target / "style.css").read_text(encoding="utf-8") == "body{}"
    assert (target / "script.js").read_text(encoding="utf-8") == "console.log(1)"


@pytest.mark.workspace
def test_write_generated_code_rejects_unknown_type():
    """T10 集成：不支持的生成类型抛 ValueError。"""
    with pytest.raises(ValueError):
        write_generated_code(f"{WORKSPACE_ROOT}/x", "vue_project", "ignored")
