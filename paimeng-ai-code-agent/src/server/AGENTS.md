# src/server/

Node-side domain code, consumed by route handlers, scripts and tests. Client code uses `src/shared` contracts and HTTP; runtime imports stay on the server.

## Layout

```
src/server/
├── AGENTS.md      # this file: module boundaries, not a file inventory
├── business.ts    # app CRUD and orchestration used by HTTP routes
├── auth/          # sessions, roles, password hashing
├── generation/    # one Generation from submit to settle
│   ├── durable-engine.ts   # Next-side attach client: submit, SSE translation, accounting, cancel/steer
│   ├── control-store.ts    # authority, execution, input and question ledgers
│   ├── prompts/            # instructions handed to the model (per Generation type + web capability)
│   ├── tools/              # the agent's tool surface; web/ is the web-access implementation behind it
│   └── durable/            # the harness process: attach HTTP surface, hooks, model admission, storage
├── billing/        # Credit: Rate card, ledger, settlement, monthly quota, admin grants
├── delivery/      # build, immutable Delivery, preview server
├── versioning/    # git-backed Version history, ledger, migration, thumbnails
├── templates/     # versioned skeletons copied into new apps
├── workspace/     # app/execution project trees, uploaded objects, legacy artifact import
├── infra/         # config, Postgres schema, Redis, snowflake ids, HTTP envelope, network parsing
└── models/        # provider/alias configuration, secrets, admin
```

## Boundaries

- `infra/` is the lowest layer: it may not import `generation/`, `delivery/`, `versioning/` or `workspace/`. `infra/config` reads only `infra/network` for allow-network parsing.
- `business.ts` stays the app-level orchestration entry the routes use; splitting it would move logic rather than file paths. Tests and scripts may import module internals directly.
- `generation/tools/` holds tool definitions and their execution; the harness entry keeps tool registration and the run-mutating hooks (effect gate, model/tool budgets, workspace path guard) together because their order is part of behaviour.
- `generation/durable/harness-server.ts` is a process entrypoint: `package.json` (`durable:harness`), `scripts/dev/durable-dev.ts`, `scripts/verify/test-e2e.ts` and the durable integration tests resolve its path literally. Moving it means updating those entrypoints.
- `generation/prompts/` builds prompt text only; it must not import tool registries, so reading instructions never starts the web or build stack.
- `billing/` may import `infra/`, `shared/` and the pure `generation/generation-accounting` helpers (`stopReasonFrom`). It must not import `generation/generation-lifecycle.ts`, `generation/durable-engine.ts` or `generation/control-store.ts`: every terminal path there already imports `billing/`, so the reverse direction would close a cycle.
- The dependency direction is generation → billing, through one entry point: `billing/settlement.ts`'s `settleGenerationBilling`. Terminal paths call it after their transaction commits; billing reads tables, never writes generation state.
