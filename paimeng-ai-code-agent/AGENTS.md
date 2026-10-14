<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# 项目约定：规则必须和强制手段成对出现

没有强制手段的规则等于没有规则。下面每条都对应一次真实返工，改代码前先看右边那列。

```bash
npm run check:ui          # 静态检查 src/**/*.tsx 的 UI 写法
npm run check:e2e         # 静态检查 tests/e2e 的地址写法与 locator
npm run test:e2e:dev      # 真实 dev 构建里抓 antd/React 告警（默认 3020/3021，不动你占着的 3000）
npm run test:e2e:isolated # 隔离的完整 E2E（生产构建）
```

| 规则 | 强制手段 |
| --- | --- |
| 不要用 `{' '}` 做间距。antd 的 `Form.Item` 会因此拿到多个子节点，开关/输入框变成死控件：界面会动但不进表单、保存不落库、重开显示默认值（2026-10-12 六个开关全废）。用 `Space` 或 CSS gap。 | `npm run check:ui`；`npm run test:e2e:dev`；`tests/e2e/model-manage.spec.ts` 的开关断言 |
| 有 `name` 的 `Form.Item` 直接子节点必须是控件本身，不能外包一层 `Space`/`Space.Compact`/`div` 等包装元素：antd 只把 `value`/`onChange` 注入直接子节点，包装元素会静默丢掉它们，字段永远收不到值（2026-10-13 别名「上游模型名」下拉选中后保存不落库，且没有任何告警）。按钮、提示等放到 `Form.Item` 外面。 | `npm run check:ui` 的 Form.Item 绑定规则；`tests/e2e/model-manage.spec.ts` 的「从下拉里选中的上游模型名会写进数据库」 |
| 不要用 antd v6 已废弃的写法：`Space direction=` → `orientation`，`Input addonAfter/addonBefore` → `Space.Compact`。这类告警只在 dev 构建出现，生产构建 E2E 抓不到。 | `npm run check:ui`；`npm run test:e2e:dev` |
| E2E 里不要写死 `http://localhost:3000` / `http://127.0.0.1:3001`，也不要用 `ADMIN_PARITY_BASE` 这类自造变量。隔离运行会把地址换掉（`E2E_APP_PORT`/`E2E_PREVIEW_PORT`），写死会让整批用例 ECONNREFUSED（2026-10-14 一次 10 个用例集体失败）。统一从 `tests/e2e/support/app-origin.ts` 取。 | `npm run check:e2e`；`npm run test:e2e:isolated` |
| 不要在 E2E 里用 `getByRole('option')` / `getByRole('alert')`：会命中外层隐藏元素（antd 下拉、Next 路由公告），表现为「element is not stable」直到超时。用 `.ant-select-dropdown:not(.ant-select-dropdown-hidden)` + `getByText`，或 `.ant-alert-error[role="alert"]`。 | `npm run check:e2e` |
| 改了 `src/**/*.tsx` 要跑真实 dev 构建的告警门禁。`E2E_APP_MODE=dev` 用独立 `distDir`（`NEXT_DIST_DIR`，见 `next.config.ts`）起第二个 dev server，所以你自己的 `npm run dev` 可以一直开着。 | `npm run test:e2e:dev`；`tests/e2e/dev-warnings.spec.ts` |
| 容器构建命令的预算不要写死代码里。整机负载高时容器内 `npm ci`/`vite build` 会超过预算，真实 Docker 构建用例报「构建超时」（2026-10-12/13 三次踩到）。 | `BUILD_TIMEOUT_MS`（默认 180000；`vitest.config.ts` 给测试 300000）；`tests/artifacts.test.ts`、`tests/templates.test.ts`、`tests/integration/agent-vue-build.test.ts` |
| 端口被占用时不要用 `pkill -f`/`pgrep -f` 清理：模式串会匹配到你自己的命令行并把当前 shell 杀掉（exit 143）。用 `ss -ltnp` 取 PID，或 `[n]ext` 这类括号技巧。 | `scripts/test-e2e.ts` 的端口报错文案（会告诉你怎么换端口） |
| 只改 `paimeng-ai-code-agent/`，旧代码与开发库只读：旧 Java（`archive/paimeng-ai-code-backend/`，含其下的 `paimeng-ai-code-mother-microservice/` 微服务骨架）与旧 Vue（`archive/paimeng-ai-code-mother-frontend/`）都只归档不动。 | 人工复核 + `git status`；`npm run verify:boundary` 对整树取 sha256（改动后哈希会变，不要为了让哈希通过而改它） |
