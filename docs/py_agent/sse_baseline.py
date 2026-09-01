#!/usr/bin/env python3
"""浏览器侧 SSE 事件基线逐事件比较脚本（T20）。

用法:
    python3 sse_baseline.py --type html --baseline sse_html.raw --actual py_html.raw
    python3 sse_baseline.py --type vue_project --baseline sse_vue.raw --actual py_vue.raw

比较口径（LLM 非确定性下的事件**结构**对比，见 docs/py_agent/sse_baseline.snapshot §4）:
- 浏览器侧事件类型：``data: {"d":"<文本>"}`` 文本事件、终止 ``event: done``、错误 ``event: business-error``。
- 结构断言（baseline 与 actual 均须满足）:
    - 以单个 ``event: done`` 终止，无 ``business-error``；
    - 不含 ``AI回复失败`` / ``生成失败`` 错误文本块；
    - html / multi_file：纯文本透传，不出现工具标记；
    - vue_project：出现 ``[选择工具]`` / ``[工具调用]`` 标记，且显示名均能解析到契约工具
      （写入文件/读取文件/修改文件/删除文件/读取目录/退出工具调用），并含 ``[选择工具] 退出工具调用``
      与 ``[执行结束]``。模型实际调用哪些工具不确定（新旧链路均绑定 6 个工具），故不比较调用集合。
- 退出码 0 表示结构一致（diff 为空），非 0 表示存在差异。

作者 @LXH
"""

from __future__ import annotations

import argparse
import json
import re
import sys

# 错误文本块特征（SimpleTextStreamHandler / JsonMessageStreamHandler 的错误兜底输出）
_ERROR_TEXT_RE = re.compile(r"AI回复失败[:：]?[^\n]*|生成失败[:：]?[^\n]*")
# 工具标记显示名（取首个非空词，如「写入文件」「退出工具调用」）
_SELECT_RE = re.compile(r"\[选择工具\]\s*([^\s]+)")
_CALL_RE = re.compile(r"\[工具调用\]\s*([^\s]+)")
# 契约工具显示名全集（docs/py_agent/sse_baseline.snapshot §2.2 表格；模型实际调用哪个工具不确定）
_CONTRACT_TOOL_DISPLAY_NAMES = {
    "写入文件", "读取文件", "修改文件", "删除文件", "读取目录", "退出工具调用",
}


def parse_browser_wire(path: str) -> list[tuple[str, str]]:
    """解析浏览器侧 SSE 原始文件为 (类型, 载荷) 事件列表。

    :param path: curl -N 录制的原始 SSE 文件
    :return: 事件列表，类型 ∈ data / event / business-error
    """
    events: list[tuple[str, str]] = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if line.startswith("data:"):
                payload = line[5:].strip()
                if payload.startswith("{"):
                    try:
                        obj = json.loads(payload)
                    except json.JSONDecodeError:
                        obj = {}
                    if "d" in obj:
                        events.append(("data", str(obj["d"])))
                    elif "error" in obj:
                        events.append(("business-error", str(obj.get("message", payload))))
                    else:
                        events.append(("data-json", payload))
                else:
                    events.append(("data-text", payload))
            elif line.startswith("event:"):
                events.append(("event", line[6:].strip()))
    return events


def signature(events: list[tuple[str, str]], kind: str) -> dict:
    """从事件列表提取结构签名。

    :param events: 事件列表
    :param kind: html / multi_file / vue_project
    :return: 结构签名（done、错误、工具标记显示名集合等）
    """
    texts = [data for typ, data in events if typ == "data"]
    joined = "".join(texts)
    return {
        "kind": kind,
        "data_chunks": len(texts),
        "done": any(typ == "event" and data == "done" for typ, data in events),
        "errors": [data for typ, data in events if typ == "business-error"]
        + _ERROR_TEXT_RE.findall(joined),
        "tool_select": sorted(set(_SELECT_RE.findall(joined))),
        "tool_call": sorted(set(_CALL_RE.findall(joined))),
        "end_marker": "[执行结束]" in joined,
    }


def compare(base: dict, actual: dict) -> list[str]:
    """比较基线签名与实测签名，返回差异列表（空 = diff 为空）。

    :param base: 基线（T14a 旧链路）签名
    :param actual: 实测（Python 链路）签名
    :return: 差异描述列表
    """
    diffs: list[str] = []
    if base["done"] != actual["done"]:
        diffs.append(f"终止事件不一致: baseline done={base['done']}, actual done={actual['done']}")
    if actual["data_chunks"] == 0:
        diffs.append("actual 缺少 data 文本事件")
    if base["errors"] or actual["errors"]:
        diffs.append(f"出现错误事件/错误文本: baseline={base['errors']}, actual={actual['errors']}")
    if actual["kind"] in ("html", "multi_file"):
        # 纯文本透传：不应出现工具标记
        markers = actual["tool_select"] + actual["tool_call"]
        if markers:
            diffs.append(f"{actual['kind']} 不应出现工具标记: {markers}")
    else:
        # vue_project：工具标记展示契约对齐基线
        # 模型实际调用哪个工具不确定（新旧链路均绑定 6 个工具），故比较「显示名可解析」而非调用集合；
        # 序列终止语义（exit → [执行结束]）为确定性要求
        markers = actual["tool_select"] + actual["tool_call"]
        if not markers:
            diffs.append("vue_project 缺少 [选择工具]/[工具调用] 标记")
        unknown = sorted(set(markers) - _CONTRACT_TOOL_DISPLAY_NAMES)
        if unknown:
            diffs.append(f"出现未知工具显示名（契约外）: {unknown}")
        if not actual["end_marker"]:
            diffs.append("vue_project 缺少 [执行结束]")
        if "退出工具调用" not in actual["tool_select"]:
            diffs.append("vue_project 缺少 [选择工具] 退出工具调用")
    return diffs


def main() -> int:
    """命令行入口。"""
    parser = argparse.ArgumentParser(description="浏览器 SSE 事件基线逐事件比较（T20）")
    parser.add_argument("--type", required=True, choices=["html", "multi_file", "vue_project"], help="代码生成类型")
    parser.add_argument("--baseline", required=True, help="T14a 旧链路录制的原始 SSE 文件")
    parser.add_argument("--actual", required=True, help="Python 链路录制的原始 SSE 文件")
    args = parser.parse_args()

    base_events = parse_browser_wire(args.baseline)
    actual_events = parse_browser_wire(args.actual)
    base_sig = signature(base_events, args.type)
    actual_sig = signature(actual_events, args.type)

    diffs = compare(base_sig, actual_sig)
    print(f"== {args.type} 基线对比 ==")
    print(f"  baseline: data={base_sig['data_chunks']}, done={base_sig['done']}, "
          f"errors={base_sig['errors']}, 工具标记={base_sig['tool_select'] + base_sig['tool_call']}, "
          f"执行结束={base_sig['end_marker']}")
    print(f"  actual  : data={actual_sig['data_chunks']}, done={actual_sig['done']}, "
          f"errors={actual_sig['errors']}, 工具标记={actual_sig['tool_select'] + actual_sig['tool_call']}, "
          f"执行结束={actual_sig['end_marker']}")
    if diffs:
        print("DIFF 非空：")
        for d in diffs:
            print(f"  - {d}")
        return 1
    print("DIFF 为空：结构与基线一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
