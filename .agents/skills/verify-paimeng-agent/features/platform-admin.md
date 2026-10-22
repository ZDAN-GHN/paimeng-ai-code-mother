# 平台管理

应用生命周期与管理端：创建、编辑、预览、发布（部署）、下载源码；管理员查用户与应用、改状态。这是唯一一条从注册到上线的完整用户旅程。

## Sub-features

- 注册 → 登录 → 创建应用 → 生成 → 编辑（可视化选元素）→ 预览 → 发布 → 下载源码。
- 应用列表与详情弹窗：修改、删除（仅创建者）；管理员只见修改/删除入口，不能生成或发布别人的应用。
- 部署：构建产物 → 部署运行时 → 返回可访问地址；全栈类型另有专属数据库。
- 预览：`/preview/<key>/` 反向代理到应用进程，按需启动、闲置回收。
- 管理员：用户管理、应用管理（分页、查询、编辑）。
- 来源校验：请求来源必须匹配 `APP_ORIGIN`，跨源请求被拒（`platform-origin.spec.ts`）。

## How to get to it (user POV)

1. `/user/register` 注册 → `/user/login` 登录 → 首页创建应用。
2. 生成后进 `/app/chat/<appId>`；「编辑」进 `/app/edit/<appId>` 选元素改样式。
3. 顶栏「预览」打开预览，「发布」部署，「下载」拿源码。
4. 管理员从用户菜单进 `/admin/appManage`、`/admin/userManage`。

## Driving it with Playwright

```bash
node .agents/skills/verify-paimeng-agent/helpers/verify.mjs tests/e2e/platform.spec.ts
node .agents/skills/verify-paimeng-agent/helpers/verify.mjs tests/e2e/admin-parity.spec.ts
node .agents/skills/verify-paimeng-agent/helpers/verify.mjs tests/e2e/platform-origin.spec.ts
```

- `platform.spec.ts` 是端到端主旅程（注册→生成→编辑→预览→发布→下载），`platform.spec.ts` 里还有按 `codeGenType`（html / multi_file / vue / react）分别跑真实构建与预览的用例，这些会真的起构建，时间较长。
- 管理员用例通过接口建号后改库角色；权限边界断言：普通用户访问 `/admin/*` 被挡，管理员在他人应用上没有生成/发布按钮。
- 来源校验用例直接构造跨源请求断言被拒，不需要浏览器导航。

## Gotchas

- 部署会真的构建并起进程；一次验证可能几分钟。别在验证过程中另起 `npm run build`。
- 预览按需启动：第一次请求 `/preview/<key>/` 才会拉进程，首个请求慢是正常的。闲置回收后再次访问会重启。
- 发布写的是真实数据库列（`deploy_key`、`deployed_runtime_url`、部署库凭据），断言要看库也要看返回地址能否打开。
- 全栈（`ts_fullstack`）用例需要 Docker（MySQL 容器）；`doctor.mjs` 不检查 Docker，跑之前自己确认 `docker info`。
- 管理员账号不能靠注册获得管理员角色；不要为了「省事」直接在测试里改生产库。
