# Golden journey fixture schema

黄金旅程是 eval、基线采集和最终回归共同消费的冻结输入。每个文件使用 YAML 1.2 的 JSON 子集书写，因此可以被标准 YAML 解析器读取；本仓库的确定性校验器使用 Node.js 内置 JSON 解析，不引入运行时依赖。

## Schema

```yaml
{
  "id": "unique-kebab-case-id",
  "title": "human-readable title",
  "category": "homepage|store|portfolio|booking|content",
  "tags": ["clarification", "memory"],
  "executionMode": "fake_llm|real_model",
  "expect": ["memory_retention", "deterministic_gate"],
  "turns": [
    {
      "action": "chat|answer|confirm_generation|abort",
      "message": "optional user input",
      "answers": [{"key": "style", "optionId": "minimal", "text": "optional"}],
      "approvalId": "optional approval id",
      "expectEvents": ["questions", "ai_response", "wireframe", "generation/proposed", "approval/asked", "awaiting_user", "milestone", "tool_request", "tool_executed", "done", "error", "aborted"]
    }
  ]
}
```

Required top-level fields are `id`, `title`, `category`, `tags`, `executionMode`, `expect`, and `turns`. Every journey has at least one turn and one expectation. `chat` is a free conversation turn, `answer` continues a clarification, `confirm_generation` is the human approval action, and `abort` records the interruption path.

`executionMode=fake_llm` means the journey is deterministic and can run in CI without provider credentials. `executionMode=real_model` marks journeys whose final gate is provider/network validation by the main agent. This distinction does not change runtime behavior.

The runner validates the frozen journeys and writes the documented report shape. Real capture accepts only the canonical repository `eval/journeys` directory; `--journeys` is not an alternate capture source. The replay manifest is mandatory in real mode and is validated before the adapter is loaded. External adapters must export `capture(journey, replay)`. They may use only the validated `replay.turns` for endpoint stimuli; each journey replay uses one stable run ID across all turns. Unsupported actions must fail closed rather than fall back to another endpoint.


```sh
node eval/run.mjs --journeys eval/journeys --base eval/fixtures/baseline --out ../docs/ts_agent/agent-loop-eval-report.md
```

The default `offline` mode is deterministic and does not invoke a provider. It records the turn inputs and expected events as journey-definition checks, leaves observed SSE/run/callback fields empty, and marks `real_model` journeys as `not-captured`. Use `--mode real` only when a provider capture adapter is available. The default adapter calls the local Agent HTTP path and requires `EVAL_JWT`, `EVAL_APP_ID`, `EVAL_USER_ID`, and `EVAL_WORKSPACE_PATH`; `EVAL_AGENT_URL` defaults to `http://127.0.0.1:8092`. For a controlled integration, set `EVAL_CAPTURE_ADAPTER` to an adapter module exporting `capture(journey, replay)`. The built-in HTTP adapter is a transport adapter only: it intentionally reports `complete: false` until an integration adapter supplies Java callback and model/channel evidence. A configured adapter must return `complete: true` plus every required field; otherwise the runner fails closed.



```sh
cd paimeng-ai-code-agent
node eval/validate.mjs
```

The validator checks JSON/YAML syntax, required fields, unique IDs, action/event/metric enums, category coverage, and the required scenario coverage. It exits non-zero on any violation.

## Metrics

The report always defines these five metrics. Values are calculated only from `observed: true` records and are separated by `fake_llm` and `real_model`; missing input is reported as `status: pending` with `value: null`.

| Metric | Definition | Required observed input |
| --- | --- | --- |
| `memory_retention` | Mean cross-message retention rate | `crossMessageMemory.baselineRetentionRate` |
| `deterministic_gate_pass_rate` | Passed deterministic gates / measured gates | `deterministicGate.passed` |
| `clarify_rounds` | Mean clarification rounds per observed journey | `clarifyRounds` |
| `run_tokens` | Mean token count per observed journey | `runTokens` |
| `done_ratio` | Completed observed journeys / observed journeys | `done` |

The deterministic gate, token, and completion inputs are post-chain (A3-A6) evidence. They remain `pending` when absent; the runner never infers them from expected events or journey names. Fake-LLM results are never included in the real-model aggregate, and vice versa.

Optional capture adapters may return the metric evidence fields alongside the required trace fields: `deterministicGate: {"passed": true}`, `clarifyRounds`, `runTokens`, and `done`. Use synthetic or approved evaluation data only.

## Coverage matrix

| Scenario | Journey IDs | Mode |
|---|---|---|
| Ambiguous clarification | `homepage-ambiguous`, `store-ambiguous` | fake_llm |
| Clear direct progress | `homepage-direct`, `portfolio-direct`, `content-direct` | fake_llm |
| Wireframe | `homepage-wireframe`, `store-wireframe`, `booking-wireframe`, `content-wireframe` | real_model |
| Human approval | `store-approval`, `portfolio-approval`, `booking-approval`, `content-approval` | fake_llm |
| Limit/truncation | `homepage-limit`, `portfolio-limit` | fake_llm |
| Deterministic gate failure | `store-build-failure`, `booking-artifact-failure` | fake_llm |
| Heuristic gate failure | `portfolio-heuristic-failure`, `content-heuristic-failure` | real_model |
| Abort | `booking-abort`, `content-abort` | fake_llm |
| Insufficient credit | `store-insufficient-credit`, `homepage-insufficient-credit` | fake_llm |
| Multi-message memory | `homepage-memory`, `portfolio-memory` | fake_llm |

The matrix contains 25 journeys across five product categories. The validator requires all 25 journeys, and each journey declares whether it is fake-LLM-only or real-model validated.

## Refund Anchor Audit

`../scripts/verify-refund-anchor.mjs` is a read-only comparator for a PG `session_event` export. It accepts either a JSON event array or the raw CSV form produced by this controlled export command:

```sh
psql "$PG_DSN" -c "COPY (SELECT app_id, run_id, kind, payload FROM session_event WHERE run_id IS NOT NULL ORDER BY app_id, seq) TO STDOUT WITH CSV HEADER" > refund-samples.csv
node scripts/verify-refund-anchor.mjs refund-samples.csv
```

The export must provide `run/end` with `status` and `filesWritten`; the audit derives milestone counts from `run/milestone`, successful write paths from `tool/call` plus `tool/result`, deterministic gate evidence from `gate/verdict`, and retry counts from verdict outcomes. Invalid, incomplete, or ambiguous per-run input fails closed without a conclusion.

The command writes only its Markdown comparison to stdout. It never writes the input, contacts a database, or changes credits. Exit `0` means all observed existing milestone anchors and audit-only tool-fact anchors agree; exit `2` means at least one difference requires human review; exit `1` means malformed input. Neither conclusion changes the existing Java 70%/50%/full-refund rules. The synthetic [sample](fixtures/refund-samples.json) and [zero-difference report](fixtures/refund-anchor-report.md) are committed solely as reproducible audit fixtures.
