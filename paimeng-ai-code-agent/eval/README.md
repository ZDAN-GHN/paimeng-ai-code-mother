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
      "expectEvents": ["questions", "wireframe", "generation/proposed", "approval/asked", "awaiting_user", "milestone", "tool_request", "tool_executed", "done", "error", "aborted"]
    }
  ]
}
```

Required top-level fields are `id`, `title`, `category`, `tags`, `executionMode`, `expect`, and `turns`. Every journey has at least one turn and one expectation. `chat` is a free conversation turn, `answer` continues a clarification, `confirm_generation` is the human approval action, and `abort` records the interruption path.

`executionMode=fake_llm` means the journey is deterministic and can run in CI without provider credentials. `executionMode=real_model` marks journeys whose final gate is provider/network validation by the main agent. This distinction does not change runtime behavior.

## Validation

```sh
cd paimeng-ai-code-agent
node eval/validate.mjs
```

The validator checks JSON/YAML syntax, required fields, unique IDs, action/event/metric enums, category coverage, and the required scenario coverage. It exits non-zero on any violation.

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
