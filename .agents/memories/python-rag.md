# 记忆：Python RAG（`paimeng-ai-code-rag/`）

> 检索服务，P4 实施；目标设计见 `docs/ts_agent/architecture.md` §8。目录由旧 Python Agent 于 2026-09-03 整体重命名而来（用户决策：骨架复用起点，取代原"新建目录后删除旧目录"方案）。

## 当前状态

- **未实施**（P4 才动工）；目录当前承载退役 Python Agent 代码（T0-T20 曾全部完成并实机验证的 FastAPI 骨架），作为 RAG 骨架复用起点。
- 可复用骨架模式：`app/main.py` 唯一入口 + `/healthz`、`app/api/auth.py` Bearer 校验（缺失/错误→401）、`app/core/config.py` pydantic-settings、`uv.lock` 锁定（Python 3.14.7 + FastAPI 0.141.1，`pip check` 全绿）。
- P4 实施时精简：删除 Agent 专属模块（`core/graph|state|guardrails`、`services/codegen|images|llm|quality`、`prompts/`、`workspace/`、`tools/`、`api/routes|streaming|callback`），保留骨架与测试基建。

## day-1 设计结论（架构 §8）

- `POST /v1/retrieval/context`：入参 app_id / user_id / code_gen_type / 需求文本 → `{few_shots[], preferences}`；**只读 MySQL 账号**直查业务表/视图（务实耦合）；鉴权服务间 Bearer；仅内网不暴露浏览器。
- v2：ingest 推送管道 + 自有 schema + pgvector，调用方无感；PG 当前停用（runbook 见 `deployment.md`），v2 重启。
- 知识沉淀先于检索：反馈数据（采纳/拒绝/编辑 diff/偏好/需求→方案对）MVP 落 MySQL 结构化表，数据量到千级再启用语义检索。

## 踩坑

- `uv run` 因 DSH 沙箱拒 `~/.cache/uv` 写入 → 直接调 `.venv/bin/uvicorn`（迁移后 `wsl-rt-env/python/.venv/bin/uvicorn`）。
- 目录内 `.env` 为退役 Agent 遗留（含联调密钥），已 gitignore 不提交；P4 实施时按新 `.env.example` 重建。

## 指针

- 退役 Python Agent 的设计/契约/验证记录（TS 移植参考源）：`docs/py_agent/`（`task_plan.md` / `progress.md` / `findings.md`）。
