"""工作区沙箱校验与原子写入测试（§1.2 / §1.5）。"""

import pytest

from app.workspace import atomic_write_files, validate_workspace_path

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
