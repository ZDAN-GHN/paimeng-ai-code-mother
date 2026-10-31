# PR #96 证据（一次性分支，审查完可删）

代码在 `feat/credit-billing`，这个 `evidence/pr-96` 分支只放证据，不参与合并。

## 截图（隔离环境，production build）

| 文件 | 场景 |
| --- | --- |
| `billing/admission-home.png` | 首页「创建并生成」被 402 就地拦住 |
| `billing/admission-chat.png` | App chat 新请求被拦住，消息原文保留在输入框 |
| `billing/owner-balance.png` | Owner 额度条：配额池 / 余额池 / 透支线 |
| `billing/admin-grant.png` | Admin 发放与回执 |
| `billing/owner-ledger.png` | Owner `/billing`：金额、分池明细、面额说明、窄屏 |
| `billing/admin-usage-reversal.png` | Admin 用量面板与整笔冲正 |
| `billing/rate-card-versions.png` | Rate card 多版本，历史版本仍在表里 |
| `billing/overdraft-abort.png` | 透支熔断中止后的中断说明 + 停止原因 + 最终账单 |

## 日志

- `logs/e2e-before.txt`：修复前 4 个 Playwright 用例失败
- `logs/e2e-after.txt`：修复后 16/16 通过
- `logs/gates.txt`：type-check / 单测 470 / 集成 468 / check:fast
- `logs/migrations-from-zero.txt`：删表 + 清迁移记录后，008→018 依次应用
