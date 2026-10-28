# 功能地图

验证的维护源。每个文件对应一个用户能直接碰到的功能，写清用户怎么走到它、用 Playwright 怎么驱动、什么可观察结果算通过、哪些坑会让人误判。

| 功能 | 文件 | 入口 | 证明什么 |
| --- | --- | --- | --- |
| 注册与登录 | [auth.md](auth.md) | `/user/register`、`/user/login` | 新账号能注册、登录、进入首页；未登录被挡在受保护页面外 |
| 创建应用并生成 | [generation.md](generation.md) | `/` → `/app/chat/<id>` | 选技术栈、填描述、创建应用，harness 生成出可预览的文件 |
| 应用编辑、部署与下载 | [app-edit-publish.md](app-edit-publish.md) | `/app/chat/<id>`、`/app/edit/<id>` | 改名落库、部署出封面与访问链接、下载 zip、版本面板 |
| 管理端模型管理 | [admin-models.md](admin-models.md) | `/admin/modelManage` | 管理员能改提供商/别名/槽位；普通用户看不到也进不去 |
| 个人中心长期记忆 | [user-memory.md](user-memory.md) | `/user/me` | 记忆列表、编辑、删除，且按账号隔离 |

## 用法

1. 改动涉及哪个功能，先读对应文件。
2. 复制骨架到 `tests/e2e/<功能>-verify.spec.ts`，只改这次要证明的那几步。
3. `npm run check:e2e` 后跑 `bash .agents/skills/verify-paimeng/run-proof.sh tests/e2e/<功能>-verify.spec.ts`。
4. 截图写在 `runtime/evidence/<功能>/`。

## 地图不完整时

地图只覆盖当前可识别的用户路径。**不要为了让用例通过而弱化旅程**：预置数据缺少某个前置条件时，让用例失败，并把缺失原因写进该功能文件的 `Gotchas`。

新增用户可见功能时，照同一形状加一个文件：`Sub-features`、`How to get to it (user POV)`、`Driving it with Playwright`、`Gotchas`。维护流程见 `/maintain-verification-skill`。
