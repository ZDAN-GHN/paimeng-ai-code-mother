# 首页与登录

公开入口：落地页、注册、登录。这里出问题通常是「整站打不开」或开发构建告警，所以它是任何改动的第一道烟囱测试。

## Sub-features

- 首页 `/`：落地页布局、创建应用入口、公开应用列表（分页/查询）。
- 注册 `/user/register`、登录 `/user/login`：表单校验、错误提示、跳转。
- 未登录访问受保护页面时跳登录，登录后回原页面。
- 开发构建告警门禁：antd v6 废弃写法、React 告警、hydration 错误。
- 布局一致性（parity）：关键页面在窄屏/桌面下的结构与文案。

## How to get to it (user POV)

1. 打开 `/`（未登录也能看落地页）。
2. 点「登录」或「注册」，填账号密码提交。
3. 登录后回首页或直接进应用列表。

## Driving it with Playwright

```bash
node .agents/skills/verify-paimeng-agent/helpers/verify.mjs tests/e2e/home-parity.spec.ts
node .agents/skills/verify-paimeng-agent/helpers/verify.mjs tests/e2e/admin-parity.spec.ts
node .agents/skills/verify-paimeng-agent/helpers/verify.mjs tests/e2e/dev-warnings.spec.ts --dev
```

- `dev-warnings.spec.ts` **必须**配 `--dev`：antd/React 的告警只在开发构建出现，生产构建会剥离。
- 注册/登录取 cookie 的最短路径：`page.request.post('/api/user/register', { headers: { origin }, data })` 然后 `/api/user/login`。
- 断言文案与结构用稳定句柄（`getByLabel`、可见文本），不要依赖 CSS 类名层级。

## Gotchas

- 生产构建跑 `dev-warnings` 会「假绿」：拿不到任何告警。一定加 `--dev`。
- `--dev` 用独立 `distDir`（`.next/dev-check`）和 `--webpack`，所以可以和用户开着的 dev server 并存；用 Turbopack 起的话会反复重载，输入框根本初始化不了。
- 注册是公开接口但受来源校验（`origin` 头必须匹配 `APP_ORIGIN`）；用 `appOrigin()` 拼，别手写。
- 首页列表依赖公开应用数据，测试库里数据会累积；断言用「包含」而不是「等于某个数量」。
