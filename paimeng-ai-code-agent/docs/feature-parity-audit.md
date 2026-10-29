# 功能与页面复刻核对

## 实现补齐记录（2026-10-10）

本节反映补齐后的工作区。下方“原始调查”保留修复前的结论与 22 张基线截图，不代表当前实现状态。F01–F21 的缺失已补齐，V01–V10 的目标结构与主要样式已恢复；fixture 浏览器验收和生产页面对照通过。仍有下文列明的视觉尺寸差异及生产环境未验证项，不声称逐像素一致或生产验收完成。

所有修改限定在 `paimeng-ai-code-agent/`。旧 Java、Vue、旧产物及开发数据库未修改，没有调用真实模型或 COS，也没有执行提交或发布。

### 功能项

| 编号 | 当前实现 | 验证证据与边界 |
| --- | --- | --- |
| F01 | 首页仅提交初始需求；后端通过模型 JSON 路由选择生成类型（HTML、多文件、Vue 工程、React 工程），保留显式类型与显式模板 API。 | `src/server/model.ts`；`tests/integration/feature-parity.test.ts` 与 `tests/e2e/home-parity.spec.ts`。模型请求格式测试覆盖 JSON 字段与四种取值；真实模型路由质量未验证。 |
| F02 | 公开应用信息独立加载，私有历史或任务失败不再清空公开详情。 | `tests/e2e/chat-parity.spec.ts` 非本人公开应用与失败历史用例通过。 |
| F03 | 以有效预览入口判断可预览性；源码可用性独立于预览和任务。失败、取消或无任务的旧应用可保留有效产物。Vue 发布重新构建当前源码。 | `tests/artifacts.test.ts`、`tests/e2e/chat-parity.spec.ts` 仅源码及旧源码加预览用例；真实旧快照迁移后的完整流程未验证。 |
| F04 | 重复发布复用合法 deployKey，暂存复制与目录替换失败时恢复原发布目录。 | `src/server/artifacts.ts` 及产物测试；真实生产链接未验证。 |
| F05 | 安全渲染 Markdown、GFM 和代码高亮，不执行原始 HTML。 | `tests/e2e/chat-parity.spec.ts` Markdown 安全渲染用例通过。 |
| F06 | 恢复四个完整需求模板，包含在线商城。 | `tests/e2e/home-parity.spec.ts` 模板和自动选类型请求用例通过。 |
| F07 | 恢复应用详情、创建者、时间、类型及按权限显示的修改/删除入口。 | `tests/e2e/chat-parity.spec.ts` 创建者、管理员与非本人分支通过。 |
| F08 | 恢复部署成功弹窗与链接复制，保留访问作品链接。 | `tests/e2e/chat-parity.spec.ts` 部署弹窗复制通过；真实 fixture 发布流程定向复验通过。 |
| F09 | 实时预览可在新窗口打开。 | `tests/e2e/chat-parity.spec.ts` 新窗口用例通过。 |
| F10 | 恢复悬停/选中标记、ID/class/页面路径展示，定位上下文随生成文本提交。 | `tests/e2e/chat-parity.spec.ts` 编辑上下文请求及实际预览选中流程通过。 |
| F11 | Enter 发送、Shift+Enter 换行，保留 Ctrl/Command+Enter。 | `tests/e2e/chat-parity.spec.ts` 与 `tests/e2e/chat-composer.spec.ts` 通过。 |
| F12 | 管理员可直接进入他人应用编辑页，保存走管理 API；创建者走普通 API。 | `tests/e2e/admin-parity.spec.ts` 与真实数据库读回的 `tests/e2e/platform.spec.ts` 定向复验通过。 |
| F13 | 编辑页恢复重置、封面预览、密钥、ID、创建者、时间、访问链接，保存后保留编辑页。 | `tests/e2e/admin-parity.spec.ts` 编辑及重置用例定向复验通过。 |
| F14 | 应用管理恢复类型筛选、封面、初始需求、部署时间、创建者及一键精选。 | `tests/e2e/admin-parity.spec.ts` 类型筛选和精选请求定向复验通过。 |
| F15 | 对话管理恢复内容搜索及查看对话入口，保留全文弹窗。长消息按钮限制在单元格内，避免邻列遮挡。 | 搜索、查看对话及全文弹窗普通点击均通过；修正宽度后单项及完整套复验通过。 |
| F16 | 管理页恢复头像、格式化时间、总条数和每页条数切换。 | `tests/e2e/admin-parity.spec.ts` 头像与分页定向复验通过。 |
| F17 | API 恢复 cover、initPrompt、deployKey 筛选。 | `src/shared/contracts.ts`、`src/server/business.ts` 与后端契约测试。 |
| F18 | 恢复 1000 字限制及原敏感词、注入模式拒绝规则；可视化上下文计入上限。 | `src/server/prompt-safety.ts` 与后端契约测试；护轨不保证识别所有恶意输入。 |
| F19 | 限流默认保持旧版策略（按用户每 60 秒 1 次，跨应用共享），并新增 `.env` 可配置的 `CHAT_RATE_LIMIT_TYPE`（`API`/`USER`/`IP`，对应旧版三种策略）、`CHAT_RATE_LIMIT_RATE`、`CHAT_RATE_LIMIT_INTERVAL`、`CHAT_RATE_LIMIT_MESSAGE`；计数写入 `ts_rate_limit` 并与任务创建同事务。 | `src/server/rate-limit.ts`、`src/server/generation-store.ts`、`migrations/005_rate_limit.sql` 与 `tests/integration/rate-limit.test.ts`；没有为浏览器测试放宽生产规则。 |
| F20 | 首页恢复共 N 个应用、共 N 个案例。 | `tests/e2e/home-parity.spec.ts` 两分页总数用例通过。 |
| F21 | schema、视图、旧记录导入保留 editTime；普通及管理员更新同时记录 editTime 和 updateTime。004 迁移修改既有列精度及默认值，不重复添加 001 已有列。 | `migrations/004_app_edit_time.sql`、后端契约及旧记录导入测试。 |

### 原版之外的扩展

| 扩展 | 内容 | 现状 |
| --- | --- | --- |
| 工程模板 | 新建 Vue 应用默认从完整可运行的 `vue-ts@1.0.0` 工程模板开始，React 应用默认从 `react-ts@1.0.0` 开始，AI 在模板上先读工程再改源码；模板版本固定依赖与锁文件，类型检查命令按模板区分（`vue-tsc` / `tsc`）。 | `templates/vue-ts/1.0.0/`、`templates/react-ts/1.0.0/`、`src/server/templates.ts`、`src/server/template-workspace.ts`；`tests/templates.test.ts`、`tests/integration/template-generation.test.ts` 与浏览器 `vue_project`、`react_project` 用例通过。原版没有该能力。 |
| 取消生成 | 聊天页提供「停止生成」，调用 `POST /api/app/generation/cancel`。只在模型写文件阶段生效；文件写完进入构建后按钮显示「构建中」并忽略取消，构建完成后仍可预览。 | `src/app/app/chat/[id]/page.tsx`、`src/server/agent.ts`；`tests/integration/agent-persistence.test.ts` 覆盖模型阶段取消、构建阶段取消与客户端断开，`tests/integration/generation-disconnect-build.test.ts` 用真实容器构建验证断开后仍产出 `dist`。原版没有该能力。 |
| 预览自动重建 | 进入聊天页时若源码存在而预览产物缺失，自动调用 `POST /api/app/build` 按现有源码重建一次（同一应用 60 秒冷却），无需重新生成或手动部署。 | `src/app/app/chat/[id]/page.tsx`、`src/server/business.ts`、`src/app/api/[...path]/route.ts`；`tests/integration/preview-rebuild.test.ts` 覆盖模板应用真实构建、HTML 应用跳过、无源码 409 与非创建者 403。原版没有该能力。 |

### 视觉项

| 编号 | 恢复内容 | 验收范围 |
| --- | --- | --- |
| V01 | 白色外壳、64px Logo、原字体回退、导航与作者页脚、非 sticky 页眉、组件默认圆角。 | 生产页面对照通过，Logo 实测 64×64；保留不同组件库的字体及页脚高度差异。 |
| V02 | 56px 渐变标题、网格、鼠标光效及标题动画，原副标题与区块尺寸。 | 首页 reduced-motion 行为测试通过；动画未录屏逐帧比较。 |
| V03 | 单个 16px 圆角阴影输入区、上箭头按钮、四个胶囊快捷按钮及原 placeholder。 | 修正组件样式优先级后生产尺寸复验通过：圆角 16px、字号 16px、背景 rgba(255,255,255,0.95)，与原版一致。 |
| V04 | 180px 封面、作者头像昵称、遮罩操作与悬停阴影；我的作品/精选案例文案。 | 键盘 focus-within 与触屏操作测试通过；生产封面高度实测 180px。 |
| V05 | auto-fill/minmax(320px,1fr)、24px 间距、768px 以下单列与 32px 移动标题。 | 生产实测间距 24px、移动标题 32px；390px 首页和聊天均无横向溢出。 |
| V06 | 720px 登录注册容器、品牌标题、副标题与右对齐跳转提示。 | 登录布局与注册校验通过；两个生产容器宽度均实测 720px。 |
| V07 | 聊天左右 2:3、白底 8px 阴影面板、原气泡与头像、18px 名称及生成类型。 | 聊天功能、桌面及移动截图通过；面板尺寸仍有下文记录的差异。 |
| V08 | 预览标题/新窗口操作、构建中状态与地球占位，1024px 以下上下各 50vh；窄屏预览操作允许整组换行。 | 最后样式修改后 3 个响应式用例通过；390px 两面板均高 422px，“访问作品”文字实测单行，人工读图确认。 |
| V09 | 1000px 编辑页两卡片、字段说明及边框信息表。 | 编辑功能及生产截图通过；容器实测 1000px、两张卡片。 |
| V10 | 全宽白底管理页、带 label 搜索区、分隔线、原列与图片/标签；长消息换行留在列内。 | 全部管理功能及长消息普通点击复验通过；三页生产对照截图保留，表格整体高度仍不同。 |

“恢复”表示目标结构与样式已有实现，不表示逐像素一致。Ant Design Vue 与 React 的字体度量、控件内部 DOM 和边距可有剩余差异。

实测残余差异：1440×1000 聊天左/右面板旧版宽约 550.4/825.6px、高 896px，新版宽约 553.6/830.4px、高 856px，仍为 2:3；390×844 移动面板旧版宽 342px、新版 366px，均高 422px。登录/注册容器高度相差约 8px，管理页面内容高度相差约 50–74px。新版保留额外的任务状态和独立发送区，并验证小窗口输入可用性；这些尺寸差异未做逐像素修正。动画仅验证 reduced-motion 行为，没有录屏逐帧比较。

### 行为、迁移与验证

B01 已恢复匿名首页空作品网格与分页，未部署卡片不额外显示编辑。B02 账号前端恢复仅必填，保留校验后的 redirect 导航便利。B03 模型上下文恢复包含当前请求最多 20 条 UI 消息；页面仍加载完整权威历史后按十条展开，这是保留的实现差异。对话记忆（滚动摘要 + 最近完整回合）上线后，默认路径不再是固定 20 条窗口（`MEMORY_ENABLED=true`），旧的 20 条窗口只在关闭该开关时生效；页面行为不变。B04 恢复合法排序列与历史排序参数，保留显式白名单。B05 仍使用本地 covers 并在返回前等待截图尝试，不声称 COS 等价。B06 仍在事务中清理文本历史及新版完整消息，保留事务方式。

旧产物迁移已新增 `scripts/import-legacy.ts --artifacts <legacy-root> --covers <dir> --strict` 能力，搬迁与快照关联的 code_output、code_deploy 和 covers。实现拒绝路径穿越、符号链接、敏感文件、预算超限及覆盖冲突，文件暂存替换与数据库事务失败时回滚新文件。相关临时 fixture 测试通过；没有执行真实旧快照导入。详见 [迁移说明](./migration-contracts.md)。

当前已观察的检查：

- 最终类型检查及 `git diff --check` 通过；Vitest 18 个文件、109 项通过，包括后端契约、产物与迁移。
- 生产构建通过；最终完整 Playwright 7 个 spec、40 项全部通过（单 worker，2.5 分钟）。长消息搜索与全文弹窗另单项通过，使用普通点击。覆盖真实 fixture 的生成、预览、可视化选中、下载、发布、数据库保存及多文件/Vue 构建。
- 最后聊天样式调整后 3 个响应式用例另通过；runner 的最终生产构建通过。
- 两版 22 张生产对照截图及模板、Markdown、公开详情、关键尺寸、移动预览链接单行断言全部通过，`screenshots/results.json` 为 `outcome: passed`。该脚本使用相同 API fixture，没有数据库写入或真实模型调用。截图生成与尺寸断言不代表逐像素一致。
- 隔离 runner 对非法预算立即退出，构建阶段总超时实测退出 1；SIGTERM 后自有进程及端口实测清理。SIGTERM 的 130 退出码仅由代码路径确认，没有直接测得退出状态。
- 独立只读源码复审未发现可确认的新增功能、安全或数据缺陷。最后一次独立复核检查当前 UI、两个 runner、审计记录、实际运行日志与测量 JSON，并逐张查看全部 22 张截图，结论为无可确认阻断项；复核未重跑测试，不代替运行验收。
- `verify:boundary` 的旧硬编码基线与当前仓库状态不一致，未修改该检查来使其通过；仓库外原有 139 个暂存删除及用户已有聊天修改保留，以实际 Git 范围核查为准。

当前可复现入口是 `npm run test:e2e:isolated`（强制 `_test` 数据库、fixture 模型、自有生产服务及进程清理）。当时的一次性 `verify:parity` 对照脚本已按脚本规则清理，历史截图与原始基线保留在 `runtime/parity-fixes/screenshots/` 和 `runtime/parity-audit/`。

### 补齐后的截图与运行证据

| 页面 | 原版（相同 fixture） | 补齐后重构版 |
| --- | --- | --- |
| 首页桌面 | [原版](../runtime/parity-fixes/screenshots/legacy-home-desktop.png) | [重构版](../runtime/parity-fixes/screenshots/current-home-desktop.png) |
| 首页移动 | [原版](../runtime/parity-fixes/screenshots/legacy-home-mobile.png) | [重构版](../runtime/parity-fixes/screenshots/current-home-mobile.png) |
| 登录 | [原版](../runtime/parity-fixes/screenshots/legacy-login-desktop.png) | [重构版](../runtime/parity-fixes/screenshots/current-login-desktop.png) |
| 注册 | [原版](../runtime/parity-fixes/screenshots/legacy-register-desktop.png) | [重构版](../runtime/parity-fixes/screenshots/current-register-desktop.png) |
| 用户管理 | [原版](../runtime/parity-fixes/screenshots/legacy-users-desktop.png) | [重构版](../runtime/parity-fixes/screenshots/current-users-desktop.png) |
| 应用管理 | [原版](../runtime/parity-fixes/screenshots/legacy-apps-desktop.png) | [重构版](../runtime/parity-fixes/screenshots/current-apps-desktop.png) |
| 对话管理 | [原版](../runtime/parity-fixes/screenshots/legacy-history-desktop.png) | [重构版](../runtime/parity-fixes/screenshots/current-history-desktop.png) |
| 应用编辑 | [原版](../runtime/parity-fixes/screenshots/legacy-edit-desktop.png) | [重构版](../runtime/parity-fixes/screenshots/current-edit-desktop.png) |
| 聊天桌面 | [原版](../runtime/parity-fixes/screenshots/legacy-chat-desktop.png) | [重构版](../runtime/parity-fixes/screenshots/current-chat-desktop.png) |
| 聊天移动 | [原版](../runtime/parity-fixes/screenshots/legacy-chat-mobile.png) | [重构版](../runtime/parity-fixes/screenshots/current-chat-mobile.png) |
| 非本人聊天 | [原版](../runtime/parity-fixes/screenshots/legacy-non-owner.png) | [重构版](../runtime/parity-fixes/screenshots/current-non-owner.png) |

运行日志：[完整 40 项 E2E](../runtime/parity-fixes/validation-final.log)、[最后 3 项响应式复验](../runtime/parity-fixes/validation-chat-layout-final.log)、[页面对照](../runtime/parity-fixes/validation-screenshots-final.log)、[布局测量 JSON](../runtime/parity-fixes/screenshots/results.json)、[最终类型检查](../runtime/parity-fixes/type-check-final.log)。运行产物位于 gitignored `runtime/`，仓库保留可重新生成的脚本入口。

真实模型的三类生成质量及多轮修改、COS、生产发布、冻结旧数据与文件迁移后的完整流程、复杂站点 CSP/外部资源兼容性仍未验证。原占位消息删除、未注册 About 和未接入业务的 Langgraph 示例仍不纳入补齐范围。

## 原始调查（修复前，仅作为问题来源及截图基线）

核对日期为 2026-10-10。目标是仅替换技术栈，保留原版用户功能、页面布局和样式。

状态为最终复核报告。源码与页面对照、业务行为复核、网页功能复核、布局样式复核及主代理证据校正均已完成。这里的完成指调查与结论整理，不代表已修复差异或完成真实模型、生产环境验收。

原版基准是归档 Java 后端 `archive/paimeng-ai-code-backend/src/main/java/com/zdan/paimengaicodemother/` 和归档 Vue 前端 `archive/paimeng-ai-code-mother-frontend/`。新版是 `paimeng-ai-code-agent/`。检查包含当前工作区未提交的聊天页修改。未将已删除的 microservice 模块和未接入业务控制器的 Langgraph 示例列入必须复刻的用户功能。

## 复核结论

当前重构版尚未达到“只替换技术栈，完整复刻功能、布局和样式”的目标。八个原路由都有实现，但业务规则发生了变化，部分页面功能和信息展示被删减，视觉样式也采用了不同的实现。

最先影响功能等价的四项是自动生成类型选择、非本人访问公开应用信息、旧应用及失败后既有产物的预览可用性、重复发布地址的稳定性，分别见 F01 至 F04。页面层面还缺少 Markdown、应用详情、部署成功及链接复制、预览新窗口入口，以及编辑页和管理页的部分功能。首页、登录注册、聊天、编辑和管理页面都有已确认的布局样式差异，见 V01 至 V10。

管理员编辑、设置精选、应用删除等能力并非全部消失，其中部分被移动到另一个入口。报告分别指出能力缺失、入口变化和行为变化，避免把它们混为一类。原版未实现的消息删除、未注册的 About 页面，以及未接入业务的 Langgraph 示例不计为必须补齐的功能。

本次只产出复核报告和验证证据，没有实施业务修复。后续维护者可按下表的问题编号核对修改范围和验收结果。

## 检查方法与范围

已逐项对照八个注册路由、页面组件及业务调用链。浏览器使用真实 Vue 与 Next 前端，并拦截 API 返回相同测试数据。桌面视口为 1440 × 1000，首页和聊天移动视口为 390 × 844。共保存 22 张截图，包含八页桌面、首页及聊天移动页面、非本人聊天页面。已等待登录用户、应用列表和聊天输入加载完成。

浏览器对照证明页面呈现和前端分支行为。后端差异以源码调用链为依据。本次未调用真实模型、未写入数据库、未实际部署应用、未验证 COS。没有执行逐像素差分，也不能据此给出功能完成百分比。

按 Prove It Works 原则核对实际前端和返回值，路由存在、迁移文档声明或测试文件存在都不作为功能验收通过的证据。每项结论标明源码确认、浏览器观察或未验证范围。

三个专项复核均由独立于主代理的子代理完成，分别检查业务行为、网页功能、布局样式；另有注释与契约核对。专项代理都使用 `oc-go/deepseek-v4.1-flash`，主代理核对其发现、源码与浏览器证据后合并，本次不称为多模型评审面板。子代理没有修改应用文件。

复核脚本和完整结果位于 `runtime/parity-audit/verify.mjs` 与 `runtime/parity-audit/results.json`。从 `paimeng-ai-code-agent/` 执行 `node runtime/parity-audit/verify.mjs` 可重复页面对照。脚本需要两版 node_modules 和 Playwright Chromium，会临时启动 Vite 4173 与 Next 3010，结束后停止自身服务。

表格中旧版 Vue 文件名相对于 `../../archive/paimeng-ai-code-mother-frontend/src/`，旧版 Java 文件名相对于 `../../archive/paimeng-ai-code-backend/src/main/java/com/zdan/paimengaicodemother/`。新版 `src/` 路径相对于 `paimeng-ai-code-agent/`。行号按本次工作树记录，源码后续修改会使行号变化。

## 优先处理的功能差异

P1 表示阻碍本次功能等价目标的主要问题，不表示整个项目的线上故障等级。

| 编号 | 优先级 | 用户可见差异 | 原版证据 | 新版证据 | 验证方式 |
| --- | --- | --- | --- | --- | --- |
| F01 | P1 | 创建应用不再由模型自动选类型。首页默认并显式提交 HTML。用户不操作类型选择时，后端关键词判断也不会执行。 | `HomePage.vue:50`；Java `AppServiceImpl.java:88` 的 `routeCodeGenType`。 | `src/app/page.tsx:11`、`:15`；`src/server/business.ts:30`。 | 源码。 |
| F02 | P1 | 非本人聊天页面无法显示已公开的应用信息。私有历史或任务读取失败时，Promise.all 不执行 setApp。旧版历史受同样权限限制，但仍保留公开应用名称及详情。 | `AppChatPage.vue:361` 先设置 appInfo，再单独加载历史。 | `src/app/app/chat/[id]/page.tsx:69`。 | 两版浏览器返回相同权限失败，旧版有应用名称，新版没有。不能据此声称旧版允许公开读取聊天历史。 |
| F03 | P1 | 预览取决于最新生成任务 ready。导入旧应用没有该任务时，即使已经复制源码，也不能从页面直接预览和重新发布。曾成功生成后，若下一次修改失败或取消，即使之前的有效产物仍在，预览也会隐藏。已有源码仍可由静态预览服务直接读取，下载 API 不以 ready 为前提，但页面的下载和发布按钮被 previewUrl 一并禁用。 | `AppChatPage.vue:381`、`:594`；Java `AppServiceImpl.java:145` 从源码目录构建发布。 | `src/server/business.ts:24`、`:62`；聊天页 `actionsDisabled`；`src/server/preview.ts:41`。 | 源码与迁移契约。未实际导入或触发生成失败、取消。仅在旧文件仍有效的场景下声称既有产物可用性退化，不保证失败时文件一定未变。 |
| F04 | P1 | 同一应用重复发布会得到新地址。原版复用已有 deployKey，新版每次生成 UUID 并更新 deployKey，原链接不会更新到最新版本。 | Java `AppServiceImpl.java:133`。 | `src/server/artifacts.ts:139`；`src/server/business.ts:63`。 | 源码。 |
| F05 | P2 | 助手回复没有 Markdown 渲染及代码高亮。标题、粗体和代码围栏直接显示为文本。 | `AppChatPage.vue:63`；`MarkdownRenderer.vue:17`。 | 聊天页 `part.type === 'text'` 分支。 | 同一消息在旧版产生代码块，新版没有。 |
| F06 | P2 | 首页缺少“在线商城”快捷需求。其余快捷需求由完整需求模板缩成一句话。 | `HomePage.vue:187`。 | `src/app/page.tsx:16`。 | 浏览器点击“个人博客网站”读取输入值，旧版是完整模板，新版是“创建一个个人博客网站”。 |
| F07 | P2 | 聊天页缺少应用详情弹窗、创建者、创建时间和生成类型展示。修改和删除的原入口也变了。 | `AppChatPage.vue:10`、`:194`；`AppDetailModal.vue:1`。 | 聊天页返回 JSX，顶部改为编辑应用、下载、发布按钮。 | 源码、浏览器。修改和删除能力仍在编辑页或管理页。 |
| F08 | P2 | 部署成功弹窗和复制部署链接按钮未复刻。新版发布成功后只提示消息并显示访问作品链接。 | `DeploySuccessModal.vue:1`、`:56`；`AppChatPage.vue:204`。 | 聊天页 `deploy` 与 `preview-bar`。 | 源码。 |
| F09 | P2 | 未部署的实时预览缺少“新窗口打开”按钮。访问作品只打开已部署地址，不能替代此功能。 | `AppChatPage.vue:166`、`:678`。 | 聊天页 `preview-bar`。 | 源码、浏览器。 |
| F10 | P2 | 可视化编辑没有保留悬停标记、选中元素的 ID/class/页面路径展示，以及发送给模型的页面路径信息。相同 selector 出现在不同页面时，修改请求缺少原来的定位上下文。 | `visualEditor.ts:203`、`:261`；`AppChatPage.vue:76`、`:436`。 | `src/server/preview.ts:17`；聊天页 `Selected`、`receive`、`submit`。 | 源码。新版桥接虽发送 pagePath，父页面不保存和使用它。 |
| F11 | P2 | 普通 Enter 不再发送消息，改为 Ctrl 或 Command 加 Enter。 | `AppChatPage.vue:120`。 | 聊天页 `onKeyDown`。 | 源码。这是交互改变，不能算等价复刻。 |
| F12 | P2 | 原管理员能在应用编辑页直接编辑任意应用。新版此页只允许创建者，管理员必须改走管理表格弹窗。 | `AppEditPage.vue:182`、`:215`。 | `src/app/app/edit/[id]/page.tsx:11`；`src/components/admin-page.tsx:23`。 | 源码。管理员后台编辑能力仍在，入口和页面信息减少。 |
| F13 | P2 | 应用编辑页缺少重置、封面预览、部署密钥、应用 ID、创建者、创建/更新/部署时间和访问链接展示。保存后也改为直接跳转聊天页。 | `AppEditPage.vue:26`、`:72`、`:82`、`:90`、`:233`。 | `src/app/app/edit/[id]/page.tsx:9`、`:11`。 | 源码、浏览器。 |
| F14 | P2 | 应用管理缺少生成类型筛选、封面、初始提示词、部署时间、创建者头像昵称和一键精选/取消精选按钮。 | `AppManagePage.vue:11`、`:36`、`:76`、`:221`。 | `src/components/admin-page.tsx:20`、`:23`。 | 源码、浏览器表头。后台仍能通过优先级设精选。 |
| F15 | P2 | 对话管理缺少消息内容搜索和“查看对话”入口。 | `ChatManagePage.vue:5`、`:55`。 | `src/components/admin-page.tsx:21`、`:23`。 | 源码、浏览器。消息全文弹窗是新版新增功能。 |
| F16 | P2 | 用户管理缺少头像图片展示。三类管理页都不再支持切换每页条数，固定每页十条，也省略总条数说明。新版直接显示时间字段，没有保留原日期格式化处理。 | `UserManagePage.vue:24`、`:115`；`AppManagePage.vue:191`；`ChatManagePage.vue:151`。 | `src/components/admin-page.tsx:15`、`:19`、`:20`、`:23`。 | 分页与头像经源码、浏览器确认。时间处理差异由源码确认，本 fixture 的日期字符串相同，没有观察到可见日期差异。 |
| F17 | P2 | 原应用列表 API 支持 cover、initPrompt、deployKey 条件，新版 pageSchema 和 listApps 没有这些字段。请求中的这些条件会在 Zod 解析时被剥离，查询结果没有按它们筛选。 | Java `AppServiceImpl.java:313` 的 `getQueryWrapper`。 | `src/shared/contracts.ts:13`；`src/server/business.ts:35`。 | 源码。旧页面未暴露全部条件，但原业务 API 能力存在。 |
| F18 | P2 | 原生成请求的敏感词和注入模式拒绝规则没有移植。原输入上限 1000，新版改为 16000。 | Java `PromptSafetyInputGuardrail.java:20`、`:37`；`AiCodeGenServiceFactory.java:157` 接入护轨。 | `src/server/agent.ts:16`、`:34`；首页和聊天 maxLength。 | 源码。文件隔离与输入拒绝规则作用不同。 |
| F19 | P2 | 原每用户 60 秒一次生成，当前实现为最近 60 秒最多十次。 | Java `AppController.java:127`。 | `src/server/generation-store.ts:87`。 | 源码。实现契约声称十分钟十次，与当前代码也不一致。 |
| F20 | P2 | 首页分页省略了“共 N 个应用”和“共 N 个案例”的总条数文案。F16 的管理页分页之外，首页也有独立缺项。 | `HomePage.vue:244`、`:269`。 | `src/app/page.tsx:16` 的两个 Pagination。 | 源码与浏览器 DOM。 |
| F21 | P2 | 原应用编辑时间 editTime 未迁移。原版普通和管理员更新应用都会记录该字段，新版 schema、共享契约和导入模型均没有它，只更新 updateTime。 | Java `model/entity/App.java:92`；`controller/AppController.java:203`、`:353`。 | `src/server/schema.ts:4`；`src/shared/contracts.ts:7`；`src/server/legacy-import.ts:7`；`src/server/business.ts:50`。 | 源码。字段丢失属于数据与契约差异，不声称旧页面曾展示 editTime。 |

## 其他已确认的行为与契约变化

下列变化有些是新增便利或实现机制替换，不宜一律称为缺失，但它们与原版并不完全等价。

| 编号 | 原版行为 | 新版行为 | 证据与限制 |
| --- | --- | --- | --- |
| B01 | 未登录首页仍有“我的作品”空网格及分页；没有部署的卡片不显示“查看作品”。 | 未登录时显示登录引导；没有 deployUrl 时卡片额外显示“编辑”入口。该入口未按创建者过滤，非本人进入后会看到权限提示。 | `HomePage.vue:228`；`AppCard.vue:11`；新版 `src/app/page.tsx:10`、`:16`。由源码确认，已登录的截图不证明匿名空态。 |
| B02 | 登录表单账号只检查必填，成功后固定回首页。 | 前端新增账号 4 至 256 位校验；登录成功尊重经过 safeRedirect 校验的 redirect 参数。 | `UserLoginPage.vue:6`、`:49`；新版 `src/components/auth-form.tsx:11`、`:12` 和 `src/client/api.ts:7`。仅说明前端校验和导航变化，不据此声称原后端接受短账号。 |
| B03 | 聊天页面通过 lastCreateTime 游标每次读取十条历史；模型记忆上限为二十条消息。 | 页面一次读取完整 app/messages，再在前端按十条逐次展开；Agent 读取全部权威历史，没有原二十条窗口限制。 | `AppChatPage.vue:308`；Java `AiCodeGenServiceFactory.java:111`；新版聊天页 `:69`、`:159`、`:174`，`src/server/generation-store.ts:28`、`:92`，`src/server/agent.ts:82`。读取机制由源码确认，未测量长历史延迟或真实模型上下文容量。 |
| B04 | 应用查询可按合法数据库列排序，历史查询接受 sortField、sortOrder。 | pageSchema 收窄排序字段，deployedTime、userId 等旧合法字段会被拒绝；历史查询实现固定按 createTime、id 降序，不使用请求排序参数。 | Java `AppServiceImpl.java:307`、`:319`；`ChatHistoryServiceImpl.java:137`；新版 `src/shared/contracts.ts:13`、`src/server/business.ts:41`、`:78`。补齐合法字段即可，不建议恢复未经限制的任意排序字符串。 |
| B05 | 发布后异步截图并上传 COS。 | 发布流程在返回前等待截图尝试，封面存本地 runtime/covers。 | Java `AppServiceImpl.java:171`、`:177`；新版 `src/server/business.ts:64`、`src/server/artifacts.ts:173`。执行顺序和存储变化由源码确认，未测量耗时，也未做 COS 验收。 |
| B06 | 删除应用后通过后台线程调用 mapper 清理文本历史。 | 同一事务显式将文本历史逻辑删除，并物理删除新版完整 ts_message。 | Java `AppServiceImpl.java:112`、`ChatHistoryServiceImpl.java:162`；新版 `src/server/business.ts:52`。旧 `model/entity/ChatHistory.java:79` 声明逻辑删除，不能凭 deleteByQuery 方法名将原操作认定为物理删除。此处只确认清理执行方式变化，不声称原文本历史保留方式不同。 |

当时的旧记录导入脚本仅处理用户、应用和文本历史，品牌资源脚本只复制 Logo，不负责搬迁 code_output、code_deploy 和 covers。品牌资源脚本已清理；旧记录导入仍是待执行的 legacy 迁移入口。源码、发布目录和封面需要另行迁移；未复制发布目录时，旧 deployKey 在新版对应地址没有文件。本次未实际导入快照，F03 还需要独立解决任务 ready 门槛。

## 网页布局与样式差异

这些是原版基准与新版实现的直接差异，不代表推荐原版所有设计。

| 编号 | 页面 | 未复刻的布局或样式 | 证据 |
| --- | --- | --- | --- |
| V01 | 全局 | 原版主体白底，首页自定义纹理背景；新版全局使用暖色渐变并统一设置 10px 圆角。Logo 从 64px 改为 54px，页眉增加 sticky 和下边框，用户头像从默认尺寸改为 small；页脚作者 GitHub 链接改成“派蒙 AI 应用工坊”。导航新增对话管理入口。 | `GlobalHeader.vue:143`、`GlobalFooter.vue:6`、`BasicLayout.vue:21`；新版 `providers.tsx:14`、`:16`、`globals.css:1`。 |
| V02 | 首页 | 56px 渐变标题改为 44px 普通标题，背景网格、鼠标跟随光效和标题动效没有复刻。副标题由 20px 改为 18px，区块标题由 32px 改为 24px。Hero、快捷按钮区与区块标题的垂直间距不同，容器 padding 20px 改为 32px 24px。 | `HomePage.vue:279`、`:354`、`:367`、`:410`、`:436`、`:478`、`:527`；`globals.css:1`；同数据截图与 DOM。 |
| V03 | 首页输入 | 原版单个无边框输入框，16px 圆角、20px 内边距、明显阴影和聚焦上移效果，右下角上箭头按钮；新版卡片包默认输入框、增加类型下拉、底部文字按钮。Placeholder 不同。四个胶囊快捷按钮变为三个普通按钮，“作品展示网站”改名“作品展示页面”。两版输入区外边距仍相同，差异在内部结构、高度和装饰。 | `HomePage.vue:169`、`:446`、`:452`、`:478`；新版首页 JSX 与 CSS；桌面及移动截图。 |
| V04 | 首页卡片 | 原版 180px 封面、作者头像昵称、悬停遮罩操作和上浮阴影；新版 160px 封面、初始需求文本、常驻底部按钮，无作者信息和原 hover 动效。区块名“我的作品/精选案例”改成“我的应用/精选应用”。 | `AppCard.vue:1`、`:58`、`:76`；新版首页 `AppCards`；`globals.css:1`。 |
| V05 | 首页响应式 | 原版网格以 minmax(320px,1fr) 自适应，gap 24px，768px 以下一列；新版默认三列、gap 20px、900px 以下两列、600px 以下一列。移动标题 32px 改为 30px，输入区改成上下排列的类型选择与创建按钮。 | `HomePage.vue:535`、`:558`；`globals.css:1`。390px 两版均无横向溢出，只证明该宽度可用。 |
| V06 | 登录注册 | 原版 720px 白色容器，标题带品牌、副标题、右对齐跳转提示；新版 440px 居中卡片，新增字段 label/图标，副标题消失，跳转提示居中。 | `UserLoginPage.vue:1`、`:64`；`UserRegisterPage.vue:1`；新版 `auth-form.tsx` 与 `globals.css:1`。 |
| V07 | 聊天 | 原版左右 flex 2:3，白底、8px 圆角阴影；新版左栏 320–420px 固定范围，右栏填充，两栏白底、12px 圆角边框，页面外层改用暖色渐变。原蓝色用户气泡、左右头像和助手灰气泡被文字角色与浅色整块消息替代。顶栏应用名 18px 改为 22px，生成类型蓝标签改为任务状态标签，“部署”改名“发布应用”。 | `AppChatPage.vue:4`、`:773`、`:822`、`:857`、`:915`；新版聊天 JSX 与 `globals.css:1`；截图。 |
| V08 | 聊天预览与移动 | 预览标题和按钮不同。原版独立的生成中大 Spin 与“正在生成网站”状态未复刻，占位的地球图标也改为纯文字。原版 1024px 以下上下布局，各 50vh；新版断点 900px，聊天和预览区采用另一套高度。 | `AppChatPage.vue:150`、`:175`、`:181`、`:987`；新版聊天 JSX 与 `globals.css:1`；390px 截图。 |
| V09 | 编辑页 | 原版 1000px 两卡片，基本信息表单加带边框信息表；新版 680px 单卡片。字段说明、计数、卡片标题与背景样式均不同。 | `AppEditPage.vue:8`、`:90`、`:283`；新版编辑页与 `globals.css:1`；截图。 |
| V10 | 管理页 | 原版全宽白底、带 label 的搜索区、divider、表格；新版限制在 1200px，新增页面标题及圆角容器，搜索区只有 placeholder。列顺序、头像/图片、消息/角色标签、固定列和表格滚动宽度不同。日期格式化实现变化见 F16，当前同数据截图没有证明日期显示不同。 | 三个旧管理页；新版 `admin-page.tsx:19`、`:23` 与 `globals.css:1`；三页截图。 |

两版主色都为 `#cb573e`，不能将整体视觉差异概括成主色被替换。旧实际字体栈来自 `App.vue:37`，新版来自 `globals.css:1`，新版省略了 Roboto、Oxygen、Ubuntu 等字体回退。旧 `assets/base.css` 没有被入口或其他源码导入，其中 Inter 和暗色媒体规则不是本次需要复刻的生效样式。证据为旧 `main.ts:8`、`App.vue:37` 和源码引用搜索。字体回退在不同操作系统上的可见影响未验证。

## 已保留、改变或无需补齐的项目

八个原 URL 都存在。注册、登录、退出、管理员查询、应用名称修改/删除、三种生成类型、历史读取、可视化点击选中、源码下载和发布都有对应代码。这里表示存在实现，不表示本次已对所有后端操作做端到端验收。

当前工作树聊天页有空历史、无任务的新应用自动提交 effect，原版的首次自动生成行为已恢复。`implementation-contract.md:55` 仍写不自动生成，与当前实现不一致。新 `tests/e2e/chat-initial-prompt.spec.ts` 针对该行为，部分既有平台测试仍使用手动发送预期，见下方文档与测试记录。不要依据 HEAD 或旧文档把当前自动生成算为缺失。

原对话管理的删除按钮没有调用后端，只显示“删除成功”。该占位界面未迁移，不能计为已实现功能的丢失。原筛选 AI 消息使用 assistant，而 Java 实际存储 ai；新版使用 ai，应保留修正，不应照抄旧错误。

`AboutPage.vue` 未在原 router 注册，不属于缺失 URL。Langgraph 图片收集、Logo、插画和质量检查示例没有接入原当前业务 controller，不应直接算成网页功能遗漏。

完整工具消息、停止生成、任务状态、并发租约和安全预览来源是新版新增或替换机制。它们不能证明原 UI 已复刻，也不自动等价于功能缺失。预览独立来源有安全作用，但新 CSP 对外部脚本、字体、跨域请求和表单的限制会改变生成站点的能力，需要单独验收。

封面生成在新版仍有实现，但 COS 云存储改成 runtime/covers 本地文件，属于运行能力变化。真实模型的三类生成质量、实际生产封面上传、复杂生成网站的外部资源和旧应用导入后的完整用户流程未在本次验收。

## 复核校正与未验证项

已排除以下误判。新版对话管理仍有用户 ID 筛选，实际缺失只有 F15 中的消息内容搜索与查看对话入口。管理员仍可在管理页编辑他人应用和设置精选，只是原编辑页入口与一键按钮没有保留。两版首页输入区外边距同为 24px；聊天两栏本身仍为白底；日期在当前 fixture 下显示相同。浏览器第一次截图的登录态等待问题和模拟预览字符编码问题已修正并重跑，不列为产品缺陷。

后端复核提出的“旧版物理删除文本历史”判断未采纳，旧实体有逻辑删除注解，单凭 mapper 方法名不足以支持该结论，见 B06。

原首页“查看对话”附带的 view=1 参数没有被原聊天页读取，不单独计为功能缺失。原部署虽然使用本地目录复制，仍有实际的网站访问能力，不将它归类为假部署。封面需要凭据也不表示原版没有封面功能。

现有 `implementation-contract.md:51` 将限流写成十分钟十次，代码实际是六十秒十次，见 F19；`:55` 关于不自动生成的说明与当前工作树矛盾。`tests/e2e/platform.spec.ts` 还有创建后任务为空、随后点击发送的预期，需要与当前自动生成行为同步。这些是源码与文档、测试预期之间的已确认差异，本次没有运行这些测试，不声称它们已失败。

本次未验证的行为包括真实模型下三类应用生成及多轮修改、实际发布与稳定链接、ZIP 内容、截图与 COS、旧数据和文件迁移后的完整流程、真实预览内的可视化编辑桥接，以及受新 CSP 限制的外部资源和表单。源码能证明规则发生变化，不能替代这些运行验收。动画仅核对旧有新无的源码，没有录屏或逐帧检查。

## 后续补齐顺序

以下顺序是本次调查的建议，不表示已经开始修复。

1. 先处理 F01 至 F04，恢复自动类型选择、公开应用信息独立加载、既有有效产物的预览可用性和稳定发布地址。同时补齐旧文件迁移，避免只有记录没有产物。
2. 补齐 F05 至 F16、F20 的页面功能和信息展示。保留可视化编辑的页面定位上下文，恢复管理筛选、快捷操作和分页能力。
3. 核对 F17 至 F19、F21 及 B03 至 B06 的业务与数据规则。显式记录决定保留的行为变化，避免接口、文档和页面各自采用不同规则。
4. 按 V01 至 V10 逐页恢复原布局、样式和响应式断点，使用相同数据截图验收。修正当前契约和测试预期后，再进行真实模型、产物迁移与发布的端到端验收。

## 截图对照

| 页面 | 原版 | 重构版 |
| --- | --- | --- |
| 首页桌面 | [原版](../runtime/parity-audit/legacy-home-desktop.png) | [重构版](../runtime/parity-audit/current-home-desktop.png) |
| 首页移动 | [原版](../runtime/parity-audit/legacy-home-mobile.png) | [重构版](../runtime/parity-audit/current-home-mobile.png) |
| 登录 | [原版](../runtime/parity-audit/legacy-login-desktop.png) | [重构版](../runtime/parity-audit/current-login-desktop.png) |
| 注册 | [原版](../runtime/parity-audit/legacy-register-desktop.png) | [重构版](../runtime/parity-audit/current-register-desktop.png) |
| 用户管理 | [原版](../runtime/parity-audit/legacy-users-desktop.png) | [重构版](../runtime/parity-audit/current-users-desktop.png) |
| 应用管理 | [原版](../runtime/parity-audit/legacy-apps-desktop.png) | [重构版](../runtime/parity-audit/current-apps-desktop.png) |
| 对话管理 | [原版](../runtime/parity-audit/legacy-history-desktop.png) | [重构版](../runtime/parity-audit/current-history-desktop.png) |
| 应用编辑 | [原版](../runtime/parity-audit/legacy-edit-desktop.png) | [重构版](../runtime/parity-audit/current-edit-desktop.png) |
| 聊天桌面 | [原版](../runtime/parity-audit/legacy-chat-desktop.png) | [重构版](../runtime/parity-audit/current-chat-desktop.png) |
| 聊天移动 | [原版](../runtime/parity-audit/legacy-chat-mobile.png) | [重构版](../runtime/parity-audit/current-chat-mobile.png) |
| 非本人聊天 | [原版](../runtime/parity-audit/legacy-non-owner.png) | [重构版](../runtime/parity-audit/current-non-owner.png) |
