# Agent Instructions

## Scope
- Active services: Java backend in `paimeng-ai-code-backend/`, TS Agent in `paimeng-ai-code-agent/`, Vue frontend in `paimeng-ai-code-frontend/`, and P4 RAG work in `paimeng-ai-code-rag/`.
- Shared infrastructure belongs in `infra/`; deployment configuration and operational scripts belong in `ops/`; static project resources belong in `assets/`.
- `runtime/tmp/` is local runtime state; `archive/paimeng-ai-code-microservice/` is a deprecated experiment and neither is a development or migration baseline.

## Toolchains
| Area | Requirement | Dependency command |
|---|---|---|
| Java backend | Java 21, Maven Wrapper | `cd paimeng-ai-code-backend && ./mvnw dependency:go-offline` |
| TS Agent | Node.js >= 20, npm lockfile | `cd paimeng-ai-code-agent && npm install` |
| Frontend | npm lockfile | `cd paimeng-ai-code-frontend && npm install` |
| RAG | Python >= 3.14, uv lockfile | `cd paimeng-ai-code-rag && uv sync` |

## Commands
| Area | Task | Command |
|---|---|---|
| Java backend | Run one test class | `cd paimeng-ai-code-backend && ./mvnw -Dtest=ClassNameTest test` |
| Java backend | Verify | `cd paimeng-ai-code-backend && ./mvnw verify` |
| TS Agent | Run one test file | `cd paimeng-ai-code-agent && npm run test -- test/server/healthz.test.ts` |
| TS Agent | Type-check | `cd paimeng-ai-code-agent && npm run type-check` |
| TS Agent | Build | `cd paimeng-ai-code-agent && npm run build` |
| Frontend | Type-check | `cd paimeng-ai-code-frontend && npm run type-check` |
| Frontend | Lint (writes fixes) | `cd paimeng-ai-code-frontend && npm run lint` |
| Frontend | Build | `cd paimeng-ai-code-frontend && npm run build` |
| Frontend | Regenerate API types | `cd paimeng-ai-code-frontend && npm run openapi2ts` |
| RAG | Run one test file | `cd paimeng-ai-code-rag && uv run pytest tests/test_sse.py` |
| RAG | Run suite | `cd paimeng-ai-code-rag && uv run pytest` |
| Local infrastructure | Start dependencies | `docker compose up -d` |

## Key Conventions
- The TS Agent is the only active code-generation path; its test layout mirrors `src/` under `paimeng-ai-code-agent/test/`.
- Keep browser-to-Agent changes coordinated with the frontend SSE client in `paimeng-ai-code-frontend/src/utils/agentSse.ts`.
- Keep the Java output roots and Agent `WORKSPACE_ROOT` aligned with `runtime/tmp/code_output`; root `docker-compose.yml` mounts `runtime/tmp/code_deploy`.
- Keep secrets only in ignored `.env` files; use `paimeng-ai-code-agent/.env.example` and `paimeng-ai-code-rag/.env.example` as templates.
- Do not commit `runtime/tmp/`, generated build outputs, or local infrastructure credentials.
- `npm run lint` and `npm run format` in the frontend modify files; inspect the diff after running them.
- Do not start the RAG service or enable it in the main generation path before its P4 work is implemented.

## References
| Need | File |
|---|---|
| Repository topology and local service roles | `README.md` |
| TS Agent run and test details | `paimeng-ai-code-agent/README.md` |
| Frontend run and test details | `paimeng-ai-code-frontend/README.md` |
| RAG run and test details | `paimeng-ai-code-rag/README.md` |
| Domain-document discovery convention | `docs/agents/domain.md` |
| GitHub issue workflow | `docs/agents/issue-tracker.md` |
| Local services and required environment variables | `docker-compose.yml` |
| Docker and Nginx configuration | `infra/docker/` |
| Database initialization and migrations | `infra/sql/` |
| Deployment configuration and operational scripts | `ops/` |

## Detailed Rules
When working on specific areas, read the corresponding rule doc in `.agents/rules/`:

| Task | Rule File |
|---|---|
| Engineering workflow, commits, verification | `.agents/rules/engineering.md` |
| Service boundaries and responsibilities | `.agents/rules/project-boundaries.md` |
| TypeScript conventions | `.agents/rules/typescript.md` |
| API contracts and wire protocols | `.agents/rules/api-contracts.md` |
| Frontend Vue components and state | `.agents/rules/frontend.md` |
| Admin UI interactions | `.agents/rules/admin-ui.md` |
| Java backend architecture | `.agents/rules/backend.md` |
| Database and migrations | `.agents/rules/database.md` |
| Error handling | `.agents/rules/errors.md` |
| Logging standards | `.agents/rules/logging.md` |
| Testing and acceptance | `.agents/rules/testing.md` |

See `.agents/rules/README.md` for the full index.

## Skill Triggers for This Project
When working on tasks matching these patterns, automatically use the corresponding skill:

- 变更前分析影响范围、评估风险、确定验证入口时：使用 `task-evidence-analysis` 技能，勿手工重复其步骤
- 工作已有明确、可执行的 spec、Ticket、验收标准或已授权修复目标，需要落实为可验证代码变更时：自动使用 `realize` 技能，勿手工重复其步骤
- 代码审查、PR 审查、分支合并前检查 Standards 和 Spec 合规性时：使用 `code-review` 技能，勿手工重复其步骤
- 审查代码质量、检查代码坏味道、重构建议、TS Agent 生成代码质量检查时：使用 `clean-code-reviewer` 技能，勿手工重复其步骤
- 故障诊断、Bug 定位、服务异常、接口报错、SSE 断连等问题分析时：使用 `incident-evidence-diagnosis` 技能，勿手工重复其步骤
- 设计审查、方案评估、API 契约变更、跨服务调用设计、架构风险检查时：使用 `grilling` 技能，勿手工重复其步骤

## Commit Attribution
- AI-assisted commits must end with `Assisted-by: <agent-name>/<model-id>`; do not guess an unknown model ID

## Issue Closure
- Before closing a GitHub Issue, execute or otherwise verify every stated acceptance and validation item; record the actual evidence.
- Update every Issue-body acceptance and validation checkbox individually from that evidence before posting the Delivery Record or closing the Issue.
- Do not close an Issue with unchecked, skipped, failed, or scope-changed criteria; keep it open until the criterion is met or its approved replacement is documented in the Issue body.

## Subagent Model Selection

If the Agent supports dynamic model selection for Subagents, follow the model selection guidelines in `MODELS.local.md`.
