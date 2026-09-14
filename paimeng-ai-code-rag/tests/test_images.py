import json

import pytest

from app.services.images import (
    ImageCollectionPlan,
    ImageResource,
    ImageTools,
    ImageCategory,
    collect_images,
    plan_image_collection,
)


class _FakeResponse:
    def __init__(self, content: str) -> None:
        self.content = content
        self.tool_calls = None


class _FakeModel:
    def __init__(self, content: str) -> None:
        self._content = content

    def bind_tools(self, tools):
        return self

    def invoke(self, messages, **kwargs):
        return _FakeResponse(self._content)


def test_plan_parses_full_plan(monkeypatch):

    payload = """```json
{
  "contentImageTasks": [{"query": "产品图"}],
  "illustrationTasks": [{"query": "插画"}],
  "diagramTasks": [{"mermaidCode": "graph TD;A-->B", "description": "架构"}],
  "logoTasks": [{"description": "科技公司 Logo"}]
}
```"""
    monkeypatch.setattr(
        "app.services.images.create_chat_model", lambda **kw: _FakeModel(payload)
    )
    plan = plan_image_collection("做一个科技官网")
    assert [t.query for t in plan.content_image_tasks] == ["产品图"]
    assert plan.illustration_tasks[0].query == "插画"
    assert plan.diagram_tasks[0].mermaid_code == "graph TD;A-->B"
    assert plan.logo_tasks[0].description == "科技公司 Logo"


def test_plan_fallback_empty_on_parse_failure(monkeypatch):

    monkeypatch.setattr(
        "app.services.images.create_chat_model", lambda **kw: _FakeModel("乱七八糟")
    )
    plan = plan_image_collection("做一个页面")
    assert plan == ImageCollectionPlan()


class _FakeHttp:
    def __init__(self, json_data) -> None:
        self._json = json_data

    def raise_for_status(self):
        return None

    def json(self):
        return self._json


def _make_tools(http_client) -> ImageTools:
    return ImageTools(settings=_FakeSettings(), http_client=http_client)


class _FakeSettings:
    pexels_api_key = "pexels-key"
    dashscope_api_key = "dashscope-key"
    image_model = "wan2.2-t2i-flash"


def test_search_content_images_parses_pexels(monkeypatch):

    responses = {
        "photos": [{"alt": "a", "src": {"medium": "http://x/1.jpg"}}, {"src": {}}]
    }

    class _Client:
        def get(self, url, **kwargs):
            return _FakeHttp(responses)

    tools = _make_tools(_Client())
    images = tools.search_content_images("猫")
    assert len(images) == 1
    assert images[0]["category"] == ImageCategory.CONTENT
    assert images[0]["url"] == "http://x/1.jpg"


def test_search_content_images_skips_without_key():

    class _NoKey:
        pexels_api_key = ""
        dashscope_api_key = ""

    tools = ImageTools(settings=_NoKey(), http_client=object())
    assert tools.search_content_images("猫") == []


def test_generate_logos_parses_dashscope(monkeypatch):

    responses = {"output": {"results": [{"url": "http://x/logo.png"}]}}

    class _Client:
        def post(self, url, **kwargs):
            return _FakeHttp(responses)

    tools = _make_tools(_Client())
    images = tools.generate_logos("科技公司 Logo")
    assert len(images) == 1
    assert images[0]["category"] == ImageCategory.LOGO
    assert (
        "禁止包含任何文字"
        in "生成 Logo，Logo 中禁止包含任何文字！Logo 介绍：科技公司 Logo"
    )


def test_generate_architecture_diagram_failure_returns_empty(monkeypatch):

    monkeypatch.setattr(
        "app.services.images.subprocess.run",
        lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("no mmdc")),
    )
    tools = _make_tools(_FakeHttp({}))
    assert tools.generate_architecture_diagram("graph TD;A", "架构") == []


def test_image_tools_bound_names():

    tools = ImageTools(settings=_FakeSettings(), http_client=object())
    names = {getattr(t, "name", "") for t in tools.tools()}
    assert names == {
        "searchContentImages",
        "searchIllustrations",
        "generateArchitectureDiagram",
        "generateLogos",
    }


def test_collect_images_collects_from_tool_results():

    class _ToolCallResponse:
        def __init__(self, content, tool_calls) -> None:
            self.content = content
            self.tool_calls = tool_calls

    class _CollectModel:
        def __init__(self) -> None:
            self._turns = 0

        def bind_tools(self, tools):
            return self

        def invoke(self, messages, **kwargs):
            if self._turns == 0:
                self._turns += 1
                return _ToolCallResponse(
                    "",
                    [
                        {
                            "id": "1",
                            "name": "searchContentImages",
                            "args": {"query": "猫"},
                        }
                    ],
                )
            return _ToolCallResponse("收集完成", None)

    class _FakeImageTools:
        def tools(self):
            return []

        def execute(self, name, args):
            return json.dumps(
                [
                    {
                        "category": ImageCategory.CONTENT,
                        "description": "猫",
                        "url": "http://x/1.jpg",
                    }
                ]
            )

    images = collect_images(
        "做个宠物站", model=_CollectModel(), image_tools=_FakeImageTools()
    )
    assert len(images) == 1
    assert images[0].url == "http://x/1.jpg"
    assert images[0].category == ImageCategory.CONTENT
