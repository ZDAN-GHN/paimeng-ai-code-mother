# Refund Anchor Audit Report

- Input: `refund-samples.json` (sanitized synthetic session-event export)
- Command: `cd paimeng-ai-code-agent && node scripts/verify-refund-anchor.mjs eval/fixtures/refund-samples.json`
- Runs: 3
- Differences: 0
- Conclusion: `zero-difference`

| Run | Status | Callback files | Tool files | Milestones | Deterministic gates passed | Retries | Existing milestone anchor | Tool-fact anchor | Result |
| --- | --- | ---: | ---: | ---: | --- | ---: | --- | --- | --- |
| refund-advanced-match | aborted | 1 | 1 | 3 | yes | 0 | advanced-partial | advanced-partial | match |
| refund-basic-match | aborted | 1 | 1 | 2 | no | 1 | basic-partial | basic-partial | match |
| refund-failed-match | failed | 0 | 0 | 0 | no | 0 | full-refund | full-refund | match |

The comparison is read-only and audit-only. It does not alter Java settlement/refund ratios, ledgers, input files, or databases.
