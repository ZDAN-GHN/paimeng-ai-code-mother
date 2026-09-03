# 记忆：TS Agent（Node，`paimeng-ai-code-agent/`）

> 目标架构与实施顺序权威：`docs/ts_agent/architecture.md`；wire 契约（#5 定稿）：`docs/ts_agent/contract.md`。本文件只记实施状态、决策摘要与移植指针。

## 当前状态

- **2026-09-03 用户决策：目录名复用 `paimeng-ai-code-agent/`**（旧 Python Agent 目录已整体重命名为 `paimeng-ai-code-rag/`，见 `python-rag.md`）。
- 技术栈：Node + Fastify + TypeScript + Vercel AI SDK + XState v5；不直连 MySQL（红线），业务数据只经 Java 回调。
- 实施票据链：#3 骨架 → #4 run 生命周期 → #5 最小生成流 + 契约定稿 → #6 回调打通 → #7-#9 核心能力 → #10 积分 → #11 对账 → #12/#13 前端 → #14 灰度+T21。

## 移植参考（Python Agent 实测资产，代码现位于 `paimeng-ai-code-rag/`）

- 提示词 7 份：`paimeng-ai-code-rag/app/prompts/`（源 `src/main/resources/prompt/*.txt`）
- 解析正则：`paimeng-ai-code-rag/app/services/codegen/parsing.py`；guardrail：`paimeng-ai-code-rag/app/core/guardrails.py`
- 工具沙箱：`paimeng-ai-code-rag/app/workspace/manager.py`（`validate_workspace_path` + `atomic_write_files`）；图片四工具：`paimeng-ai-code-rag/app/services/images.py`
- 契约测试模式：`paimeng-ai-code-rag/tests/test_contract.py`（TS 侧按语义比对移植）

## 移植要点（Python 实测契约教训，TS 重写必须保持）

- vue 工具名/参数键必须驼峰（`writeFile/readFile/modifyFile/deleteFile/readDir/exit`、`relativeFilePath/oldContent/newContent`…），否则 Java `ToolManager` 与浏览器展示取 null。
- exit 工具的模型调用不确定：模型直接给最终答案时须补发 exit 事件（`exit-{uuid}`），保证事件序列与基线一致。
- 工作区原子写入：临时 stage 目录必须建在目标**父目录**（sibling），建在目标内部则 rename 时 stage 随之移动导致路径失效。
- Java `bodyToFlux(ServerSentEvent)` 解码 SSE 会产生 `data=null` 空事件：Java 客户端侧需 `filter(event -> event.data() != null)`（#6 泛化回调客户端时注意）。

## 下一步 / 指针

- #3 验收：`/healthz` 200、`/agent/*` 无/错/过期 JWT → 401、workspacePath 逃逸 → 400、冒烟端点按新 SSE 格式（六类事件）、测试一键运行。
- 测试基建约定：真实服务实例（`buildApp()`）+ `fastify.inject()` 注入式请求 + `jose` 自签 JWT。
- 进度日志：`docs/ts_agent/progress.md`（每完成一票追加一行，含命令证据）。
