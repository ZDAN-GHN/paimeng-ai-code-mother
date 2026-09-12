# Issue #37 baseline capture

Status: blocked, with an explicit non-secret blocker manifest.

## Exact capture context

- HEAD: `1f03f13f2ff4d557a18c6267f80cec92751ac0c2`
- Required command:
  `cd paimeng-ai-code-agent && node eval/run.mjs --mode real --journeys eval/journeys --base eval/fixtures/baseline --out ../docs/ts_agent/agent-loop-eval-report.md`
- Validation command:
  `cd paimeng-ai-code-agent && node eval/validate.mjs`

The frozen journey validator passed for all 25 journeys. The documented real capture command stopped before provider invocation because `EVAL_JWT` is not configured in the safe evaluation environment. No real provider request was made, so no request sequence, SSE event sequence, run phases, callback payloads, model/channel record, or generated baseline JSON is fabricated.

`capture-manifest.json` lists every frozen journey as `not-captured`, records the exact HEAD and commands, and explicitly records the contractual pre-Agent-Loop cross-message-memory baseline as zero. That zero is a baseline contract value, not a provider observation in this blocked run.

The safe evaluation identity is a runtime prerequisite and is not written to this repository. Service health was independently confirmed for PostgreSQL (`5432`), TS Agent (`8092/healthz`), Java (`8123/api/doc.html`), and frontend (`5173`); service health does not remove the missing evaluation identity blocker.
