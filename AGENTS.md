# Agent Instructions

## Scope
- Active services: Java backend in `paimeng-ai-code-backend/`, TS Agent in `paimeng-ai-code-agent/`, Vue frontend in `paimeng-ai-code-frontend/`, and P4 RAG work in `paimeng-ai-code-rag/`.
- `paimeng-ai-code-microservice/` is a deprecated experiment; do not use it as a development or migration baseline.

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
- Keep secrets only in ignored `.env` files; use `paimeng-ai-code-agent/.env.example` and `paimeng-ai-code-rag/.env.example` as templates.
- Do not commit `tmp/`, generated build outputs, or local infrastructure credentials.
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

## Commit Attribution
- AI-assisted commits must end with `Assisted-by: <agent-name>/<model-id>`; do not guess an unknown model ID.
