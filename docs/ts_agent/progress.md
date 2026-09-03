# TS Agent 实施进度日志

> 按 `.agents/memories/README.md` 更新约定：每完成一个任务追加一行，含日期与命令证据。Python Agent 时代历史见 `docs/py_agent/progress.md`。

## 2026-09-03

- **P0 止血执行完毕（Issue #2）**：`application-local.yml` 回切 `python-agent.enabled: false`；PG 停用确认（无服务、无自启机制、5432 无监听）；WSL 全栈旧 Java AI 链路 e2e 全流程验证通过——注册/登录（Redis 会话）→ 建应用（`/api/app/add`）→ SSE 生成（旧链路直出 ~80KB 完整 HTML + 终端 `event:done`）→ 落盘 `tmp/code_output/html_453132478241230848/` → 构建部署（deployKey `VYvF03`、deployedTime 落库）→ 对话历史落 MySQL。运行环境：用户态 MySQL 8.0.46（`~/.local/opt/mysql8/start.sh`，需 DSH 完整权限）+ redis-server 7.2.5（源码编译，无持久化）+ `./mvnw spring-boot:run`（需 DSH 完整权限写 `~/.m2`）。
- **目录名复用决策 + 记忆重构（用户指令）**：`git mv paimeng-ai-code-agent paimeng-ai-code-rag`（60 个跟踪文件随迁，旧 Python Agent 代码成为 RAG 骨架复用起点，取代"新建后删除"方案）；TS Agent 落位 `paimeng-ai-code-agent/`。记忆侧：删除 `.agents/memories/python-agent.md`，新建 `ts-agent.md` / `python-rag.md`（Python 实测契约教训迁移至 ts-agent.md「移植要点」）；同步 `MEMORY.md`、`.agents/memories/{architecture,java-backend,deployment,README}.md`、`AGENTS.md`、`CONTEXT.md`、`docs/ts_agent/architecture.md`（§1/§10.3 修订）、`.agents/skills/project-startup-guardrail/SKILL.md`（启动模式去 Python 化、PG 标注停用、8090→8092）。
