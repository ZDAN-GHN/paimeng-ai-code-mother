# TS Agent 实施进度日志

> 按 `.agents/memories/README.md` 更新约定：每完成一个任务追加一行，含日期与命令证据。Python Agent 时代历史见 `docs/py_agent/progress.md`。

## 2026-09-03

- **P0 止血执行完毕（Issue #2）**：`application-local.yml` 回切 `python-agent.enabled: false`；PG 停用确认（无服务、无自启机制、5432 无监听）；WSL 全栈旧 Java AI 链路 e2e 全流程验证通过——注册/登录（Redis 会话）→ 建应用（`/api/app/add`）→ SSE 生成（旧链路直出 ~80KB 完整 HTML + 终端 `event:done`）→ 落盘 `tmp/code_output/html_453132478241230848/` → 构建部署（deployKey `VYvF03`、deployedTime 落库）→ 对话历史落 MySQL。运行环境：用户态 MySQL 8.0.46（`~/.local/opt/mysql8/start.sh`，需 DSH 完整权限）+ redis-server 7.2.5（源码编译，无持久化）+ `./mvnw spring-boot:run`（需 DSH 完整权限写 `~/.m2`）。
