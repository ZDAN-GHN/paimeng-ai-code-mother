# Issue #37 baseline capture

Status: blocked, with an explicit non-secret blocker manifest.

## Exact capture context

- HEAD: `7b9ccbc8e0352cee00245a210ffd59a4e49d2d62`
- Required command:
  `cd paimeng-ai-code-agent && node eval/run.mjs --journeys eval/journeys --base eval/fixtures/baseline --out ../docs/ts_agent/agent-loop-eval-report.md`
- Validation command:
  `cd paimeng-ai-code-agent && node eval/validate.mjs`

The frozen journey validator passed for all 25 journeys. The required capture command could not start because `paimeng-ai-code-agent/eval/run.mjs` does not exist in this HEAD. No real provider request was made, so no request sequence, SSE event sequence, run phases, callback payloads, model/channel record, or generated baseline JSON is fabricated.

`capture-manifest.json` lists every frozen journey as `not-captured`, records the exact HEAD and commands, and explicitly records the contractual pre-Agent-Loop cross-message-memory baseline as zero. That zero is a baseline contract value, not a provider observation in this blocked run.

The missing runner is outside #37 ownership: implementing it would change eval runner semantics and must be handled by a follow-up ticket before real-model capture. Service health was independently confirmed for PostgreSQL (`5432`), TS Agent (`8092/healthz`), Java (`8123/api/doc.html`), and frontend (`5173`); service health does not remove the missing-runner blocker.
