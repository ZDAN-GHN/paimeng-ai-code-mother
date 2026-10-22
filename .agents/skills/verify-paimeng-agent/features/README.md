# 功能地图

验证单元是「用户能在界面上做的事」。每个文件回答四件事：包含哪些子功能、用户怎么走到、怎么用 Playwright 驱动、有什么坑。

驱动任意一条之前先跑 `helpers/doctor.mjs`，并用 `helpers/verify.mjs <spec>` 起隔离实例。

| 功能 | 入口 | 现有 spec | 已覆盖的证明 |
| --- | --- | --- | --- |
| [对话生成与运行中输入](chat-generation.md) | `/app/chat/<appId>` | `chat-composer.spec.ts`、`chat-parity.spec.ts`、`chat-images.spec.ts`、`chat-voice.spec.ts`、`chat-initial-prompt.spec.ts`、`chat-preview-rebuild.spec.ts` | 发送/插话/排队、流式回复、预览刷新、图片与语音输入 |
| [版本历史与回退](version-history.md) | 对话页右侧版本面板 | `version-panel.spec.ts` | 树状历史、回退不新增版本、分支与合并、差异、预览重建 |
| [模型与别名配置](model-management.md) | `/admin/modelManage` | `model-manage.spec.ts` | 提供商/别名编辑、密钥密文、别名级设置、语音别名 |
| [平台管理](platform-admin.md) | `/admin/appManage`、`/admin/userManage`、`/app/edit/<appId>` | `platform.spec.ts`、`admin-parity.spec.ts`、`platform-origin.spec.ts` | 注册→生成→编辑→预览→发布→下载 全旅程、权限边界 |
| [首页与登录](home-and-auth.md) | `/`、`/user/login`、`/user/register` | `home-parity.spec.ts`、`admin-parity.spec.ts`、`dev-warnings.spec.ts` | 首屏、登录注册、开发构建告警 |

新增功能时先加一行索引，再写一个同名文件；四个 H2 标题保持不变，后续维护脚本靠它们定位。
