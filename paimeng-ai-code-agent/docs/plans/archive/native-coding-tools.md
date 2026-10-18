# Native coding tools migration

> 归档：记录当时的设计、迁移与验收。当前行为见[部署说明](../pi-durable-deployment.md)与[模型配置](../provider-convergence.md)。

Target branch `refactor/pi-durable-migration`, base `f9f4d64`. Replace generation file operations with pi-durable read/write/edit, omit bash, and let build validation reject invalid projects. Preserve custom listFiles/buildPreview and web tools. Do not touch main or archived code. Commit only after acceptance.

## Contracts and ownership

The implementation has two independently verifiable seams. Native `write` accepts `{path, content}`; `edit` accepts `{path, edits:[{oldText,newText}]}`. Keep the existing workspace-relative path boundary at tool admission. No replacement truncation or mutation queue.

| Unit | Owner and write boundary | Inputs and dependencies | Check and handoff |
| --- | --- | --- | --- |
| U1 | Native-tools worker, isolated `../.pi-worktrees/coding-tools-native`; harness-server.ts, durable-engine.ts, generation-instructions.ts, fixture-content.ts, fixture-model.ts, durable/faux-fixture.ts, build-feedback.ts, components/chat/tool-call.tsx, associated protocol/UI/fixture tests and scripts/verify-restart.ts | Base revision and settled native schemas above. Excludes workspace/artifacts/templates/static-template tests and agent instructions. | Produce patch without commit. Parent inspects diff, runs types/unit/integration and UI dev gate. Report changed files and gaps. |
| U2 | Build-boundary worker, isolated `../.pi-worktrees/coding-tools-build`; project-shape.ts, workspace.ts, artifacts.ts, templates.ts if needed, tests/static-templates.test.ts, tests/templates.test.ts, tests/workspace.test.ts, tests/artifacts.test.ts, tests/system/template-build.test.ts | Base revision. Independent from U1; preserve manifest/version checks, template lock check, npm ci, typecheck, Vite and atomic dist publication. | Produce patch without commit. Parent inspects diff and runs focused build checks plus real negative generation. Report changed files and gaps. |
| U3 | Parent, original checkout; integrate U1/U2, stale instructions, acceptance scripts/evidence and this plan | Both writer handoffs complete; no active writers at integration | Serial required checks, real generation and dependency damage/repair, fresh independent review, then branch-local commit. |

Blocking steps are settled native schemas and path admission, then component handoffs, then integration. U1/U2 can edit independently. Shared node_modules is read-only; workers do not run tests, installs, type generation, Docker or servers. All validation, databases, ports and dev processes belong to parent. Existing dev processes and in-flight builds must be reconciled before runtime acceptance. Test harnesses use separate test databases, never reset product storage.

## Acceptance

- [x] U1 and U2 inspected and integrated. Preserve structured custom tool results while native file results use text; retain template guides and protocol version guard.
- [x] `npm run type-check`, `npx tsc --noEmit` and `npm run check:fast` pass.
- [x] Final `npm test`: 31 files, 296 tests, 3.03 seconds; no external services.
- [x] `npm run durable:pg` confirms Postgres 16.15 on 127.0.0.1:5432; final `npm run test:integration`: 25 files, 130 tests, 80.54 seconds.
- [x] `npx vitest run --project system tests/system/template-build.test.ts`: both React/Vue real Docker cases pass (393.08 seconds), including lock/dependency/type failures preserving dist.
- [x] `npm run test:e2e:dev -- tests/e2e/chat-composer.spec.ts`: 15 cases pass, including dev warnings and native tool card rendering.
- [x] Real React generation through `npm run dev` and the configured `deepseek-v4.1-flash` succeeds with real Docker install/typecheck/Vite build. Browser verifies the heading, counter and native tool cards. App `469463278582497280`, conversation `643`.
- [x] Native `edit` writes `react@0.0.0-native-invalid`; build source validation rejects it with a repairable tool diagnostic. Dist hash is unchanged and previous preview stays accessible. After reading the diagnostic, the model restores `react@19.1.0`, changes the page and completes a fresh real Docker build. This verifies manifest preflight failure recovery; it is not an npm ci failure.
- [x] Independent review found native `@` path expansion and mixed image/text result regressions; fixed both, removed UI content stripping, and added 12 focused integration checks. Removing the path/text fixes causes exactly five relevant failures (`regression-red.log`). Real acceptance exposed an existing listFiles recursion bug; relative child paths fix it and the nested-directory assertion fails with the original implementation (`listfiles-red.log`). Fresh final review gives PASS for code and evidence.
- [x] Commit gate satisfied on `refactor/pi-durable-migration`; attribution verified from session records as `xhy-api/gpt-6.1-sol` and `oc-go/deepseek-v4.1-flash`. All implementation changes are inside the product directory.

All implementation changes remain inside `paimeng-ai-code-agent/`; historical spike scripts and archived evidence stay at their boundary baseline. Runtime logs and detailed scratch evidence live in ignored `runtime/evidence/native-coding-tools/`. Parent final report identifies commands actually run and any remaining gaps. Bash is excluded because tools execute on the host under the user's account.
