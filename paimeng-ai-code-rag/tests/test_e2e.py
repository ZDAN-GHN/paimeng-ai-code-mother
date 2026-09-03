"""离线工作流端到端测试（§5 阶段 2）。

给定 message + 空 history，用固定夹具快照（tests/fixtures/ golden JSON）
断言工作流产出工作区文件，不依赖在线模型。
"""

import json
from pathlib import Path

import pytest

from app.core.graph import CodeGenWorkflow
from app.core.guardrails import GuardrailResult

WORKSPACE_ROOT = "/tmp/paimeng-test-workspace"
FIXTURES = Path(__file__).parent / "fixtures"


class _EmptyPlan:
    content_image_tasks = []
    illustration_tasks = []
    diagram_tasks = []
    logo_tasks = []


class _FakeImageTools:
    def search_content_images(self, query):
        return []

    def search_illustrations(self, query):
        return []

    def generate_architecture_diagram(self, mermaid_code, description):
        return []

    def generate_logos(self, description):
        return []


class _FakeGuardrail:
    def validate(self, text):
        return GuardrailResult.allowed()


class _FixtureExecutor:
    """按固定夹具产出生成文本的执行器。"""

    def __init__(self, generated_text: str) -> None:
        self._text = generated_text

    def stream(self, code_gen_type, user_message, file_tools=None):
        yield self._text


def _run_workflow(fixture_name: str) -> dict:
    """按 golden 夹具运行工作流并返回最终状态。"""
    fixture = json.loads((FIXTURES / fixture_name).read_text(encoding="utf-8"))
    ws = f"{WORKSPACE_ROOT}/e2e_{fixture['code_gen_type']}"
    wf = CodeGenWorkflow(
        executor=_FixtureExecutor(fixture["generated_text"]),
        guardrail=_FakeGuardrail(),
        image_tools=_FakeImageTools(),
        image_plan=lambda prompt: _EmptyPlan(),
        quality_check=lambda code: {"is_valid": True},
        router=lambda prompt: fixture["code_gen_type"],
    )
    state = wf.run({"original_prompt": "做一个页面", "workspace_path": ws})
    state["_fixture"] = fixture
    return state


@pytest.mark.e2e
def test_offline_html_e2e():
    """html golden 夹具：工作区产出 index.html 且含关键片段。"""
    state = _run_workflow("golden_html.json")
    fixture = state["_fixture"]
    assert state["code_gen_type"] == "html"
    for rel_path, fragments in fixture["expected_files"].items():
        content = (Path(WORKSPACE_ROOT) / f"e2e_html" / rel_path).read_text(encoding="utf-8")
        for fragment in fragments:
            assert fragment in content


@pytest.mark.e2e
def test_offline_multi_file_e2e():
    """multi_file golden 夹具：工作区产出三文件且各含关键片段。"""
    state = _run_workflow("golden_multi_file.json")
    fixture = state["_fixture"]
    assert state["code_gen_type"] == "multi_file"
    for rel_path, fragments in fixture["expected_files"].items():
        content = (Path(WORKSPACE_ROOT) / "e2e_multi_file" / rel_path).read_text(encoding="utf-8")
        for fragment in fragments:
            assert fragment in content
