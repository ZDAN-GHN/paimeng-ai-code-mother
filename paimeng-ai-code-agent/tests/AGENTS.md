# tests/

Four suites, separated by the resources a test may start. A file's directory picks its suite; `vitest.config.ts` and `playwright.config.ts` own include, setup files and parallelism, this file owns why the boundary sits there.

## Layout

```
tests/
├── AGENTS.md              # this file: suite boundaries and scope rules
├── support/               # shared setup, server-only stub, resource guards, _test URL helpers
├── unit/                  # isolated logic and local filesystem; parallel
│   ├── client/            # browser API client, shared display and element-selection helpers
│   ├── chat/              # React chat helpers: inputs, feedback, message parts, tools, voice, images
│   ├── generation/        # prompts, accounting, budget, prompt safety, harness reporting
│   ├── tools/             # agent tool definitions; web/ is the web-access stack
│   ├── models/            # provider config, registry, adapters, probes, secrets
│   ├── delivery/          # builds, immutable deliveries, preview state
│   ├── workspace/         # project trees, templates, legacy artifacts, version summaries
│   └── infra/             # config, password, snowflake ids, HTTP envelope, legacy import
├── integration/           # real Postgres, Redis and child processes; serialized
│   ├── platform/          # HTTP contract, write authority, schema invariants, rate limit, ids
│   ├── generation/        # generation lifecycle, control store, speech, web search, templates
│   ├── harness/           # pi-durable harness process and its Postgres storage
│   ├── models/            # model admin/store; support/ is the child-process registry probe
│   ├── delivery/          # build, publish, preview and download deliveries
│   ├── versioning/        # git-backed versions, ledger, migration, API
│   └── workspace/         # isolated execution directories
├── system/                # Docker builds, Chromium and real preview servers; serialized
└── e2e/                   # Playwright against a running app
    └── support/           # app origins, proof account, evidence paths
```

## Resource boundaries

- `unit/` may use the local filesystem (temp directories, `runtime/` fixtures). Postgres, Redis, child processes and browsers are refused by `support/unit-boundaries.ts`; when a test needs one, it belongs in the next suite instead of a weakened guard.
- `integration/` uses real Postgres/Redis connections and child processes, including the pi-durable harness. It runs serialized because tests share `_test` storage and fixed ports. Use dedicated test URLs; `support/test-database-url.ts` validates and maps supported app/storage URLs to `_test`. Harness launchers must also receive a test storage URL.
- `system/` adds Docker builds, Chromium and real preview servers; still serialized.
- `e2e/` drives a running app through Playwright. Specs stay flat; helpers live in `e2e/support/`, reach the app through `support/app-origin`, and write artifacts through `support/evidence`.
- A helper shared by suites lives in `tests/support/`; one owned by a single suite lives beside it (`integration/harness/support.ts`, `integration/models/support/`).

## Scope rules

- Match assertions to the tested surface: unit logic, cross-module integration, infrastructure behaviour or user flow. Higher suites verify interactions rather than repeat lower-level cases.
- Unit tests stay deterministic without services. A behaviour that only exists against a real service is tested in the suite that provides it.
- Moving a test between suites changes what it may start, so update the config, the setup helper and any cross-suite helper import together.
