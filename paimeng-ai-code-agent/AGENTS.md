<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project conventions

Only invariants that are not obvious from the source, scripts, or tests belong here. Commands, paths, schemas, and test names live in the code and must not be duplicated in this file.

## UI

- A named `Form.Item` must receive its control directly. Wrapping it in `Space`, `Space.Compact`, `div`, or similar drops antd's injected `value`/`onChange`; the UI can still look correct while nothing persists. Keep buttons and hints outside the item.
- Do not use `{' '}` as spacing inside `Form.Item`; it turns the child list into multiple nodes and breaks binding. Use layout spacing instead.
- antd v6 deprecations warn only in development builds. A passing production E2E run is not evidence that they are absent.

## Scope and data

- The repository-root `archive/` Java and Vue code is read-only reference material.
- Reticle/end-to-end evidence uses the running development app and its real databases. The Vitest integration harness resets storage and must stay on the isolated `_test` databases; never point a resetting suite at the development databases.

## Tooling

- If re-running Reticle `init`, pass `--no-mcp`; the default recreates `CLAUDE.md`, re-adds the Reticle block to this file, and restores the `/reticle` command.
