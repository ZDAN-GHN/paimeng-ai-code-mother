# 项目记忆（MEMORY）

> 本文件是**总入口**：一句话现状 + 任务完成链 + 指向领域记忆。详细记忆在 `.agents/memories/`（见下）。
> 长期权威文档（设计、契约、验收）在 `docs/`；逐票实施细节与命令证据在 `docs/ts_agent/progress.md`。

## 一句话现状

三服务架构（2026-09-03 经四轮设计审讯定稿）：**Java**（业务/鉴权/积分/历史/构建；旧 AI 已退役）+ **TS Agent**（`paimeng-ai-code-agent/`，Node/Fastify + Vercel AI SDK + XState v5，前端 fetch-SSE 直连 + JWT，**唯一生成主链路**）+ **Python RAG**（`paimeng-ai-code-rag/`，P4 未动工）；权威设计 `docs/ts_agent/architecture.md`。旧 Python Agent 已全面退役（目录整体重命名为 RAG 复用起点，`docs/py_agent/` 转历史参考，PG 停用）。**P3 收官（2026-09-08）：#14 灰度切换 + T21 执行完毕**——旧 Java AI 与 Python 中转链按删除范围+根因清除全部删除，`ts-agent.enabled`（默认 true）门禁 JWT 签发（关闭→40410），回退手段 = git 回滚；T21 两半边判据齐（契约对等报告 + Java 91/92+路由真实 LLM 单跑绿 / TS 144/144）。当前宿主为原生 Linux Mint（MySQL/Redis/SearXNG/Nginx 经 docker compose），运行环境约定见 `deployment.md`。

## 任务完成链（详情与命令证据见 `docs/ts_agent/progress.md` 与各领域记忆）

| 票 | 日期 | 一句话 |
|---|---|---|
| #2 (P0) | 2026-09-03 | 回切旧 Java AI 主链路（`python-agent.enabled=false`），WSL e2e 验证 |
| #3 (P1) | 2026-09-03 | TS Agent 骨架：Fastify 5 + jose + 沙箱 + JWT 401 矩阵 |
| #4 | 2026-09-04 | run 生命周期：`generation_run` DDL + Java 内部 API + 409 并发拒绝 |
| #5 | 2026-09-04 | 最小生成流 + 契约定稿（XState v5 + AI SDK v7，`docs/ts_agent/contract.md`） |
| #6 | 2026-09-04 | Agent→Java 回调打通：`ai/agent/` 泛化 + 完成回调（Bearer + runId 幂等） |
| #7 | 2026-09-04 | 需求工程：五维访谈 + 免费线框 + codegen 闸门 + 每日配额 429 |
| #8 | 2026-09-04 | 生成核心移植：Guardrail/解析/文件六工具/图片四工具/提示词 7 份 |
| #12 | 2026-09-04 | 前端通道切换：Java 签发短时 JWT + fetch-SSE 直连 + 七类事件渲染 |
| #9 | 2026-09-05 | 质检门禁（三工位 + 三重门禁）+ 护栏 + 三档强度 + token 计量 |
| #10 | 2026-09-05 | 积分协议（冻结/结算/退款台账）+ 对话中断按里程碑退款 |
| #11 | 2026-09-07 | 契约对账 84 例（72 覆盖/3 差异/9 演进），T21 判据通过，144/144 |
| #13 | 2026-09-08 | 前端功能补齐：旅程状态机/访谈卡/线框确认/强度选择/中止/余额 |
| #14 | 2026-09-08 | 灰度开关 ts-agent.enabled + T21 执行：旧 Java AI 与中转链删除，P3 收官 |
| #16 | 2026-09-08 | 架构优雅化第一批开工：src 13→6 领域目录 + 死代码清场（零行为变更，148/148） |
| #17 | 2026-09-08 | 真流式 SSE：hijack 逐帧写出、首帧即达（AC5 经实际直连路径验证 14ms/102ms） |
| #18 | 2026-09-08 | zod 单源：10 工具 + 3 body 解析 schema 统一、input as 清零、FileToolResult 判别联合 |
| #20 | 2026-09-08 | 重试策略参数化：短调用恢复 SDK 退避（单源常量）、长生成保持 0 |
| #19 | 2026-09-08 | 质检门禁换 generateObject：手搓 JSON 解析归零、typed 契约显式化 |
| #21 | 2026-09-08 | 路由收敛：错误单点 httpError、双轨预检（边界=首帧）、编排归位、script 退场 |

- 另：2026-09-07 双源图片搜索 + SearXNG 容器（图片搜索 Java 类已随 #14 删、能力归 TS Agent，见 `deployment.md`）；2026-09-08 nginx 部署路由容器 + 本地库全量 dump 迁移 + 快速档半价定价（`deployment.md`/`java-backend.md`/`vue-frontend.md`）；2026-09-08 四档真实 LLM provider 接入完成（路由 glm-4-flash-250414 / 快速 glm-4.7-flash / 标准 Nemotron 3 Ultra free / 深度 qwen3.7-plus@DashScope Coding，`src/llm/real.ts` + `MODEL_ROUTER` 等新配置键，路由调用点为后续特性，见 `ts-agent.md`）。
- #13 仅剩浏览器 UI 人工走查（AC1 勾选留用户）。

## 领域记忆（`.agents/memories/`）

| 文档 | 内容 |
|---|---|
| `README.md` | 记忆目录索引与更新约定 |
| `architecture.md` | 三服务目标架构决策（拓扑/鉴权/数据分工/护栏/闸门）、退役状态 |
| `java-backend.md` | Java 侧状态、编译红线、迁移残留、关键事实 |
| `ts-agent.md` | TS Agent（`paimeng-ai-code-agent/`）实施状态、移植参考清单、契约教训 |
| `python-rag.md` | Python RAG（`paimeng-ai-code-rag/`，P4）：目录来历、可复用骨架、day-1 结论 |
| `vue-frontend.md` | 前端约定、SSE 消费基线、P3 计划改造 |
| `deployment.md` | 环境依赖（原生 Linux 默认 / WSL 两套）、运行时环境布局、敏感文件、共享工作区、启动命令 |

## 权威文档

- `docs/ts_agent/architecture.md`：**目标架构权威设计**（三服务/新 SSE 协议要点/run 表/护栏/计费/RAG/退役/实施顺序）
- `docs/ts_agent/contract.md`：TS Agent 浏览器 wire 契约（#5 已定稿）
- `docs/ts_agent/contract-parity.md`：契约对等报告（#11 终稿，T21 判据依据）
- `docs/ts_agent/progress.md`：TS Agent 实施进度日志（逐票细节与命令证据）
- `docs/py_agent/`：Python Agent 历史参考（task_plan/progress/findings/t21_delete_plan）
- `CONTEXT.md`：项目领域上下文与架构分层
- `AGENTS.md`：Agent 项目约定与任务资料路由

## 下一步

**多类型生成迁移（multi_file / vue_project）**：设计定稿 `docs/ts_agent/codegen-multi-type-design.md`（2026-09-09，经 agent-design-review 修订）。关键发现：**现行 html 提示词仍是代码块输出约定，与唯一落盘机制（writeFile 工具调用）错位**——真实通道未做过落盘 e2e，假 LLM 测试矩阵（直接发 tool-call）系统性掩盖，属带病状态。四票切分待开：A 提示词约定对齐（最前置）/ B multi_file 接线（StackProfile 策略接缝 + 真门禁）/ C per-type 预算 / D vue_project 设计先行（构建反馈环归属决策）。与 #22 正交。

**TS Agent 架构优雅化第一批收口（父 issue #15，6/6）**：#16 目录收敛 / #17 真流式 / #18 zod / #19 质检 generateObject / #20 重试 / #21 路由收敛 ✅（2026-09-08，148→160/160，含双轴审查整改 +2）；frontier 清空，XState 双轨决策 #22 待拍板（见 `ts-agent.md`）。

**P4 RAG + 盈利 MVP**：`paimeng-ai-code-rag/` 精简退役代码后 day-1 上线（few-shot 直查）+ 反馈埋点；手动充值已就绪；无执照，微信支付/公众号通知 v1.x。Python Agent **目录删除**门槛 = P4 RAG 骨架复用（当前维持「目录待删」）。每完成一个任务：更新 `.agents/memories/` 对应文档 + 本文件现状与完成链 + `docs/ts_agent/progress.md` 追加一行（含日期与命令证据）。
