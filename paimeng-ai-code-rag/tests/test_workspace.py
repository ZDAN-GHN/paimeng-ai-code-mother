

import pytest

from app.workspace.manager import atomic_write_files, validate_workspace_path, write_generated_code

WORKSPACE_ROOT = "/tmp/paimeng-test-workspace"


@pytest.mark.workspace
def test_validate_accepts_path_under_root():

    assert validate_workspace_path(f"{WORKSPACE_ROOT}/html_1") is not None


@pytest.mark.workspace
def test_validate_rejects_relative_path():

    with pytest.raises(ValueError):
        validate_workspace_path("html_1")


@pytest.mark.workspace
def test_validate_rejects_path_outside_root():

    with pytest.raises(ValueError):
        validate_workspace_path("/etc/passwd")


@pytest.mark.workspace
def test_atomic_write_replaces_workspace():

    target = validate_workspace_path(f"{WORKSPACE_ROOT}/html_atomic_test")
    atomic_write_files(target, {"index.html": "<h1>old</h1>"})


    atomic_write_files(target, {"new.html": "<h1>new</h1>"})
    assert not (target / "index.html").exists()
    assert (target / "new.html").read_text(encoding="utf-8") == "<h1>new</h1>"


    leftovers = [p.name for p in target.parent.iterdir() if p.name.startswith((".stage-", "html_atomic_test.bak"))]
    assert leftovers == []


@pytest.mark.workspace
def test_write_generated_code_html():

    target = write_generated_code(f"{WORKSPACE_ROOT}/html_gen_test", "html", "说明\n```html\n<h1>hi</h1>\n```")
    assert (target / "index.html").read_text(encoding="utf-8") == "<h1>hi</h1>"


@pytest.mark.workspace
def test_write_generated_code_multi_file():

    content = "```html\n<h1>a</h1>\n```\n```css\nbody{}\n```\n```javascript\nconsole.log(1)\n```"
    target = write_generated_code(f"{WORKSPACE_ROOT}/mf_gen_test", "multi_file", content)
    assert (target / "index.html").read_text(encoding="utf-8") == "<h1>a</h1>"
    assert (target / "style.css").read_text(encoding="utf-8") == "body{}"
    assert (target / "script.js").read_text(encoding="utf-8") == "console.log(1)"


@pytest.mark.workspace
def test_write_generated_code_rejects_unknown_type():

    with pytest.raises(ValueError):
        write_generated_code(f"{WORKSPACE_ROOT}/x", "vue_project", "ignored")
