<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project conventions

The layout below is navigation, not a spec: commands, schemas and test names still live in the code. Only invariants that are not obvious from the source, scripts or tests belong in the sections after it.

## Layout

```
paimeng-ai-code-agent/
├── AGENTS.md          # this file: layout + invariants
├── src/
│   ├── app/           # App Router pages and HTTP entries: api/[...path] business dispatch, api/durable harness attach/SSE
│   ├── server/        # Node domain modules; see src/server/AGENTS.md
│   ├── components/    # React UI the pages compose
│   ├── shared/        # zod contracts and types imported by both sides
│   └── client/        # browser API client and response envelope
├── templates/         # versioned skeletons copied into new apps: html, multi-file, react-ts, vue-ts
├── migrations/        # SQL; applied files are immutable history
├── tests/             # suites split by allowed resources; see tests/AGENTS.md
├── scripts/           # reusable entry points only; prerequisites, ports, rules in scripts/AGENTS.md
├── docs/              # contracts, ADRs, plans, prototypes; placement rules in docs/AGENTS.md
├── runtime/           # local runtime data, never source
└── public/            # static assets
```

## Read next

- Run it, prerequisites, ports: `scripts/AGENTS.md`
- Server module boundaries: `src/server/AGENTS.md`
- Cross-module invariants: `docs/implementation-contract.md`

## UI

- A named `Form.Item` must receive its control directly. Wrapping it in `Space`, `Space.Compact`, `div`, or similar drops antd's injected `value`/`onChange`; the UI can still look correct while nothing persists. Keep buttons and hints outside the item.
- Do not use `{' '}` as spacing inside `Form.Item`; it turns the child list into multiple nodes and breaks binding. Use layout spacing instead.
- antd v6 deprecations warn only in development builds. A passing production E2E run is not evidence that they are absent.

## Scope and data

- The repository-root `archive/` Java and Vue code is read-only reference material.
- End-to-end evidence uses the running development app and its real databases. The Vitest integration harness resets storage and must stay on the isolated `_test` databases; never point a resetting suite at the development databases.
