# 当前代码文件地图与 Next.js 边开发边学路线

本清单按当前工作区文件、导出函数、实际调用点与测试内容核对，包含未提交文件；它不是某个发布版本的审计报告。范围是当前应用 `paimeng-ai-code-agent/`，不展开仓库只读的 `archive/`、依赖 `node_modules/`、生成目录 `.next/`、运行数据 `runtime/`、二进制图片和既有设计文档。真实 `.env` 的内容不读取、不展示。

清单逐文件覆盖平台源码 111 个 TS/TSX，另含 CSS；共收录 315 个代码、配置或模板说明文件（src 117、scripts 27、tests 123、templates 32、migrations 6，其余为根配置）。每个路径都可点击。测试条目描述验证目标，不表示本次重新执行过。

## 先建立四个概念

- **React** 负责组件、状态、事件和界面更新；`.tsx` 是可写 JSX 的 TypeScript。
- **Next.js** 为 React 提供路由、布局、服务端渲染和 HTTP 入口。本项目使用 App Router：`page.tsx` 对应页面，`layout.tsx` 对应共享布局，`route.ts` 对应 HTTP 接口。
- **Node.js** 是服务端 JavaScript 运行环境：数据库、文件系统、harness、构建进程都在服务端执行。
- **业务系统** 是项目自己写的：权限、版本、生成控制、Redis 限流、隔离执行与不可变交付都不是 Next 自动提供的功能。

`src/server`、`src/client`、`src/shared`、`src/components` 是本项目的组织方式；Next 不会仅因目录叫 server 就自动替你拦截导入。`import 'server-only'` 才能在 Next 构建时阻止相应模块误入客户端。

页面和 layout 默认是 Server Component。`'use client'` 标记客户端模块边界，允许状态、事件和浏览器交互；Client Component 初次加载也可能先在服务端预渲染，因此不要在模块顶层/渲染期随意读取 window/localStorage。Server Component 与 API Route Handler 也是两种角色：前者输出 UI，后者响应 HTTP。

本项目多数交互页面是 Client Component，通过 `fetch('/api/...')` 调同一 Next 服务的 Route Handler，再由服务端访问 PG。这是可以先学通的具体路径。当前业务写入口主要使用 Route Handlers，未以 Server Actions 为主，不必为入门重写。

## 以实际代码纠正容易误读的地方

1. **Next 不只转发。** `durable-engine.ts` 当前运行在 Next 服务端，仍负责生成准入、观察者、最终构建/repair、发布和取消编排。常驻 harness 负责模型/工具循环和权威转录；断浏览器与重启 Next 是不同故障，不能把前者的保证扩大成“整个产品流程都不依赖 Next”。
2. **自检不是必经门槛。** 模型可以调用 buildPreview 自检，模型结束后平台还会独立验收；不是每一轮都会先自检。
3. **版本标题仍可能额外调模型。** `version-summary.ts` 的 summarizeVersion 有引擎调用点，能解析 version.summary 并回退 codegen.default；不能只按计划中“确定性标题”来解释当前实现。
4. **模型工具包含只读 Git。** 还有原生文件工具、listFiles/buildPreview/ask 与按开关提供的联网工具。实际工具面看注册代码，不仅看可能滞后的 README 清单。
5. **hooks 是可选安装。** `scripts/hooks/` 文件存在不证明已执行 hooks:install。`infra.ts` 的当前命令会启动 compose 中所有服务，也包含归档 mysql；本机 PG 另行管理。
6. **旧实现分支尚存。** agent.ts、generation-store.ts、legacy 模块及旧迁移仍被兼容路径或测试使用，文件名/老注释不能代替当前调用链。前端名称限制为 50，而当前 updateApp schema 上限为 256，也是可用于学习双端校验差异的实际例子。

## 按功能追踪的三个入口

### 修改应用名称：最适合第一条全栈链路

```text
浏览器：app/edit/[id]/page.tsx 的 save(value)
  → client/api.ts 的 api('app/update', {id, appName})
  → HTTP POST /api/app/update（这是网络边界）
  → api/[...path]/route.ts 的 dispatch
  → http.ts 检查来源/请求体 + auth.ts 的 requireUser
  → business.ts 的 updateApp / getApp
  → db.ts + schema.ts 的 apps → PostgreSQL UPDATE
  → http.ts success(true) → api.ts 解析 data
  → 页面 message.success + fetchApp() 重新读回
```

普通创建者走 app/update；管理员编辑页走 app/admin/update。前端按钮隐藏只是交互，服务端仍校验所有者/管理员。保存后当前代码显式 fetchApp，并没有因为使用 Next 就自动刷新全部页面。

### 登录：理解 Cookie 与服务端权限

```text
user/login/page.tsx → auth-form.tsx → client/api.ts
  → POST /api/user/login → auth.ts + password.ts
  → user_session 保存 token 摘要，响应设置 Cookie
  → providers.tsx refresh() → GET /api/user/get/login
  → 后续请求由浏览器带同源 Cookie，服务端每次确认会话与角色
```

### 生成：等普通业务学会后再进入

```text
聊天 page.tsx / useChat
  → POST /api/app/chat/gen/code → durable-engine.ts
  → 产品库准入、authority、execution / 独立目录
  → HTTP attach 到 harness-server.ts
  → pi-durable 模型/工具循环 → harness 存储转录
  → durable-engine 观察并转换为 AI SDK UI 消息流
  → 平台验收/有界修复 → generation-lifecycle 发布版本与交付
  → preview.ts 提供固定交付，页面 iframe 加载
```

下面各表可当索引用；学习时按上面一条链路前进，无需依次读完。

## 页面、路由与页面样式：先学这一组

| 文件 | 实际作用 |
| --- | --- |
| [src/app/layout.tsx](../src/app/layout.tsx) | 所有页面共用的根布局：输出 html/body、站点元信息，接入 Ant Design 样式注册器与全局 Providers。默认是 Server Component。 |
| [src/app/page.tsx](../src/app/page.tsx) | 首页交互：需求输入、模板选择、创建应用、我的应用与精选案例分页；创建后跳转对话页。是 Client Component。 |
| [src/app/globals.css](../src/app/globals.css) | 平台全局样式：主题、顶栏、首页、登录页、卡片及响应式布局。 |
| [src/app/user/login/page.tsx](../src/app/user/login/page.tsx) | 把 AuthForm 挂到 /user/login，本文件只负责页面入口。 |
| [src/app/user/register/page.tsx](../src/app/user/register/page.tsx) | 把 register 模式的 AuthForm 挂到 /user/register。 |
| [src/app/app/edit/[id]/page.tsx](../src/app/app/edit/[id]/page.tsx) | 应用信息编辑页：加载应用、判断编辑权限、填充/重置表单、保存名称；管理员额外编辑封面与优先级。 |
| [src/app/app/edit/[id]/edit-view.module.css](../src/app/app/edit/[id]/edit-view.module.css) | 编辑页局部样式；CSS Modules 让类名限定在该模块。 |
| [src/app/app/chat/[id]/page.tsx](../src/app/app/chat/[id]/page.tsx) | 对话页主组件：AI SDK 消息流、输入与取消、插话/排队、图片/语音、构建进度、版本面板、下载/部署、iframe 预览及元素选择。 |
| [src/app/app/chat/[id]/chat.css](../src/app/app/chat/[id]/chat.css) | 对话页布局、消息、输入区、队列、预览分栏、拖动尺寸和手机适配。 |
| [src/app/app/chat/[id]/use-generation-sync.ts](../src/app/app/chat/[id]/use-generation-sync.ts) | 自定义 Hook：合并轮询运行态、权威历史和本地输入状态；处理断流、终态、待重发输入、草稿交接与开放问题。 |
| [src/app/admin/userManage/page.tsx](../src/app/admin/userManage/page.tsx) | 用户管理路由入口，复用 AdminPage 的 user 模式。 |
| [src/app/admin/appManage/page.tsx](../src/app/admin/appManage/page.tsx) | 应用管理路由入口，复用 AdminPage 的 app 模式。 |
| [src/app/admin/modelManage/page.tsx](../src/app/admin/modelManage/page.tsx) | 模型管理路由入口，挂载 ModelManager。 |
| [src/app/api/[...path]/route.ts](../src/app/api/[...path]/route.ts) | 业务 HTTP 总入口：导出 GET/POST，用路径分发用户、应用、版本、生成、模型、上传和语音接口；执行来源、登录与角色检查。 |
| [src/app/api/durable/[...path]/route.ts](../src/app/api/durable/[...path]/route.ts) | 受创建者权限保护的 harness attach 代理：GET 覆盖为绑定会话 ID，POST 校验/补入会话 ID，转发请求与事件流；目标固定为配置的 harness。 |

## 浏览器请求与通用组件：先学这一组

| 文件 | 实际作用 |
| --- | --- |
| [src/client/api.ts](../src/client/api.ts) | 封装同源 fetch：有参数时 POST、无参数时 GET；解析统一响应信封、归一网络/业务错误，并限制登录回跳地址。泛型 T 不等于运行时验证 data。 |
| [src/components/providers.tsx](../src/components/providers.tsx) | Ant Design 主题和消息环境、登录用户 Context、顶栏菜单、退出登录与 AdminGuard；界面守卫之外仍需服务端鉴权。 |
| [src/components/auth-form.tsx](../src/components/auth-form.tsx) | 共用登录/注册表单：字段校验、提交、防重复操作、刷新用户状态和登录后跳转。 |
| [src/components/app-card.tsx](../src/components/app-card.tsx) | 首页应用卡片：封面、作者、查看对话、查看已部署作品等操作。 |
| [src/components/admin-page.tsx](../src/components/admin-page.tsx) | 复用用户/应用管理表格：筛选、分页、编辑、删除、应用优先级等管理操作。 |
| [src/components/admin-view.module.css](../src/components/admin-view.module.css) | 管理列表、筛选与编辑界面的局部样式。 |
| [src/components/model-manager.tsx](../src/components/model-manager.tsx) | 模型配置完整编辑器：提供商、槽位/别名、API 格式、密钥来源、自定义头、能力/思考参数、模型列表探测与版本冲突处理。 |
| [src/components/user-info.tsx](../src/components/user-info.tsx) | 统一展示用户头像和名称，处理缺失用户的占位。 |
| [src/components/user-info.module.css](../src/components/user-info.module.css) | 头像与用户名的行内排列和溢出样式。 |
| [src/components/clipboard-images.ts](../src/components/clipboard-images.ts) | 从粘贴/拖放提取 File，统一校验图片类型、数量和总大小，返回可接受文件与明确拒绝原因。 |

## 对话组件：掌握普通页面后再读

| 文件 | 实际作用 |
| --- | --- |
| [src/components/chat/app-detail-modal.tsx](../src/components/chat/app-detail-modal.tsx) | 应用详情弹窗：创建者、生成类型、时间与编辑/删除入口；同时提供本组件使用的显示格式函数。 |
| [src/components/chat/build-progress.tsx](../src/components/chat/build-progress.tsx) | 把进度状态渲染成生成/构建时间线，展示阶段状态、耗时和失败信息。 |
| [src/components/chat/chat-inputs.ts](../src/components/chat/chat-inputs.ts) | 输入队列的纯逻辑：合并提交回执、流式落点与历史，区分 queued/placed，恢复或移除输入，并在助手回复中分段插入用户输入。 |
| [src/components/chat/deploy-success-modal.tsx](../src/components/chat/deploy-success-modal.tsx) | 部署成功弹窗：展示访问地址、复制地址与打开网站，包含剪贴板不可用时的回退方案。 |
| [src/components/chat/generation-feedback.ts](../src/components/chat/generation-feedback.ts) | 键盘行为、进度事件解析/归约、输入状态投影、断流提示、草稿交接与中断原因文案的纯逻辑。 |
| [src/components/chat/generation-usage.tsx](../src/components/chat/generation-usage.tsx) | 按 Generation 展示模型/构建步骤、用时、token、工具调用与停止原因；包含耗时格式化。 |
| [src/components/chat/image-attachments.tsx](../src/components/chat/image-attachments.tsx) | 附图草稿 Hook、逐张上传/删除/重试、发送阻塞原因、附件 part 转换，以及草稿和历史图片的缩略图/放大展示。 |
| [src/components/chat/markdown-message.tsx](../src/components/chat/markdown-message.tsx) | 渲染助手 Markdown、GFM 和代码高亮，跳过原始 HTML；memo 与延后更新减轻流式渲染负担。 |
| [src/components/chat/tool-call.tsx](../src/components/chat/tool-call.tsx) | 解析工具消息 part，显示文件读取/修改、构建、搜索、网页和图片结果；处理半截流式参数、完成态与错误态。 |
| [src/components/chat/version-panel.tsx](../src/components/chat/version-panel.tsx) | 版本抽屉：加载/筛选历史、缩略图、差异、当前版本提示、恢复确认和恢复后的界面联动。 |
| [src/components/chat/version-panel.css](../src/components/chat/version-panel.css) | 版本列表、差异展示、抽屉及缩略图样式。 |
| [src/components/chat/voice-input.tsx](../src/components/chat/voice-input.tsx) | 浏览器录音状态机：检查能力、选择音频格式、计时/停止、上传转写、失败重试，把文字交回输入框而不自动发送。 |

## 共享契约：普通业务开发时随用随读

| 文件 | 实际作用 |
| --- | --- |
| [src/shared/contracts.ts](../src/shared/contracts.ts) | 核心业务类型及 Zod schema：用户、应用、分页、生成状态/相位、进度事件、计费步骤与 ID。供前后端共用。 |
| [src/shared/attachments.ts](../src/shared/attachments.ts) | 图片附件信息和消息 part 的结构、格式白名单、数量/体积/尺寸限制。 |
| [src/shared/chat-runtime.ts](../src/shared/chat-runtime.ts) | 运行中输入的提交结构、steer/followUp、持久输入状态、回执、待处理队列及 ChatRuntime 视图。 |
| [src/shared/display.ts](../src/shared/display.ts) | 生成类型的中文标签/选项，以及数据库 UTC 时间的解析与本地展示。 |
| [src/shared/durable-model.ts](../src/shared/durable-model.ts) | Next 与 harness 之间的公开模型身份、模型准入 token、视觉能力及错误响应 schema。 |
| [src/shared/element-selection.ts](../src/shared/element-selection.ts) | 可视化编辑的选中元素结构、最多选中数量，把页面定位信息转成模型可读文本。 |
| [src/shared/model-config.ts](../src/shared/model-config.ts) | 模型管理完整契约：槽位、能力、格式、请求头规则、别名/参数、地址/密钥引用策略、版本及管理接口载荷。 |
| [src/shared/templates.ts](../src/shared/templates.ts) | 可选模板注册清单：id、版本、显示名、对应生成类型和运行形态；首页选项与服务端解析共用。 |
| [src/shared/versioning.ts](../src/shared/versioning.ts) | 版本/差异的数据结构，完整 commit SHA 校验、恢复参数、标题兜底与工作区切换提示。 |

## 服务端基础与普通业务：学习全栈的主线

| 文件 | 实际作用 |
| --- | --- |
| [src/server/http.ts](../src/server/http.ts) | 统一成功/失败响应、BusinessError、来源与请求体大小检查、JSON 读取；长操作以空白字节心跳保持响应连接。 |
| [src/server/auth.ts](../src/server/auth.ts) | 注册、登录、退出、Cookie 会话读取、用户/管理员鉴权与安全用户视图；会话令牌只存摘要，兼容旧密码登录升级。 |
| [src/server/password.ts](../src/server/password.ts) | 带盐 scrypt 密码哈希、旧 Java MD5 校验与安全比较；另提供会话 token 的 SHA-256 摘要。 |
| [src/server/business.ts](../src/server/business.ts) | 用户与应用业务服务：CRUD/分页/权限、模板创建、版本列表/恢复/差异、素材读取、预览重建、下载及手动部署。 |
| [src/server/config.ts](../src/server/config.ts) | 从服务端环境变量读取并用 Zod 校验平台来源、数据库、Redis、模型、harness、构建、限流和联网等配置。 |
| [src/server/db.ts](../src/server/db.ts) | 延迟创建 pg 连接池与 Drizzle 实例，导出事务类型和时间格式；保留业务 bigint 精度。 |
| [src/server/schema.ts](../src/server/schema.ts) | Drizzle 表映射及控制面状态类型；部分 generation 新列通过原生 SQL 访问，数据库实际结构还需看迁移。 |
| [src/server/snowflake.ts](../src/server/snowflake.ts) | 保持旧 Java 位布局的雪花 ID 算法；用产品库持久下界协调跨进程发号，处理回拨、同毫秒耗尽和导入 ID。 |
| [src/server/redis.ts](../src/server/redis.ts) | 生成限流专用 Redis 连接与关闭、有限连接/命令等待、故障日志和资源清理。 |
| [src/server/rate-limit.ts](../src/server/rate-limit.ts) | 按用户/IP/API 选择限流键，以 Lua 原子预留固定窗口额度，后续拒绝时按原窗口 token 退款。 |
| [src/server/prompt-safety.ts](../src/server/prompt-safety.ts) | 需求文本的非空、1000 字限制、敏感词与特定注入模式检查；它是产品输入规则，不能单独保证模型安全。 |

## 生成控制与编排：进入 AI 系统时再学

| 文件 | 实际作用 |
| --- | --- |
| [src/server/agent.ts](../src/server/agent.ts) | 当前主要保留生成请求 Zod schema、附件副本命名和目录规则，以及旧取消辅助函数；实际生成入口在 durable-engine.ts。 |
| [src/server/durable-engine.ts](../src/server/durable-engine.ts) | Next 服务端的生成桥接与编排：harness HTTP/协议检查、独立会话、输入提交/撤回、事件转 AI SDK 流、历史投影、观察者/心跳、最终构建/修复、发布与取消。 |
| [src/server/generation-lifecycle.ts](../src/server/generation-lifecycle.ts) | 生成生命周期编排：准入与基线准备、源码封存、版本/交付准备、事务发布、失败/取消草稿交接、提问收束、恢复对账。 |
| [src/server/control-store.ts](../src/server/control-store.ts) | 产品库控制状态：app authority/epoch、执行绑定、持久输入序号/水位、开放问题、attempt 预算和状态转移；固定锁顺序，不在本层执行模型/Git/文件副作用。 |
| [src/server/generation-store.ts](../src/server/generation-store.ts) | generation 任务行和控制字段查询、业务写互斥、终态更新；同时保留旧 lease 准入/心跳/回收兼容代码。 |
| [src/server/generation-accounting.ts](../src/server/generation-accounting.ts) | 记录助手/构建步骤的模型身份、token、耗时、工具信息，归一停止原因，聚合为页面可展示的用量。 |
| [src/server/generation-instructions.ts](../src/server/generation-instructions.ts) | 按 HTML/多文件/Vue/React、模板、附图与联网能力拼生成指令；约束工程入口、依赖与自检工具使用。 |
| [src/server/execution-workspace.ts](../src/server/execution-workspace.ts) | 为单次执行建立 generationId/epoch 独立目录，从基线复制源码；控制写入准入、排空 writer、计算摘要并封存快照。 |
| [src/server/workspace.ts](../src/server/workspace.ts) | 通用源码目录和 ProjectRoot 抽象；校验相对路径、软链接、敏感文件、配额，提供列出/读取/原子写入等文件能力。 |
| [src/server/delivery-store.ts](../src/server/delivery-store.ts) | 创建带 manifest/摘要的不可变交付目录；校验交付归属、解析固定交付、读写预览文件指针；数据库发布事务在生命周期层完成。 |

## 模板、构建与预览

| 文件 | 实际作用 |
| --- | --- |
| [src/server/templates.ts](../src/server/templates.ts) | 服务端模板定义：源码文件清单、入口、类型检查命令、默认模板；读取/校验模板身份和 package manifest。 |
| [src/server/template-workspace.ts](../src/server/template-workspace.ts) | 把指定版本模板初始化到源码目标，写模板身份标记；已存在工程不被重复覆盖。 |
| [src/server/build-contract.ts](../src/server/build-contract.ts) | Vue/React 允许依赖及精确版本；校验工程 package.json，拒绝未知依赖与不受控依赖来源。 |
| [src/server/build-feedback.ts](../src/server/build-feedback.ts) | 标记/分类构建失败，区分模型可修源码错误和环境错误，生成修复反馈与无进展说明。 |
| [src/server/artifacts.ts](../src/server/artifacts.ts) | 源码摘要和构建状态；静态 HTML 校验、工程两阶段 Docker 安装/类型检查/Vite 构建，以及预览判定、复制部署、ZIP 下载和封面截图。 |
| [src/server/preview.ts](../src/server/preview.ts) | 独立 Node HTTP 预览服务：解析预览/固定交付/部署/封面路径，校验 Host/文件安全和 CSP，并注入可视化选中元素的桥接脚本。 |
| [src/server/fixture-content.ts](../src/server/fixture-content.ts) | 可控测试模型使用的固定回复和 HTML/多文件/Vue/React 文件内容、读取/写入步骤；不是真实模型生成器。 |

## 版本内容与台账

| 文件 | 实际作用 |
| --- | --- |
| [src/server/version-store.ts](../src/server/version-store.ts) | 封装 Git 内容操作：建库/锁/引用、隔离索引构造提交、从指定源码根提交、物化版本、切换工作区、差异统计、缩略图保存和清理。 |
| [src/server/version-ledger.ts](../src/server/version-ledger.ts) | 只操作 PG version_record：插入、列表/搜索、按 SHA 查询、改标题、检查一轮是否已有版本；不调用 Git。 |
| [src/server/version-heal.ts](../src/server/version-heal.ts) | 兼容修复：扫描 Git 保留引用，给“有引用无台账”的版本幂等补行；不能据此把所有新发布都理解为事后补账。 |
| [src/server/version-summary.ts](../src/server/version-summary.ts) | 版本短标题生成/清洗：可调用 version.summary 或 codegen.default，失败返回 null；另从助手文字提取兜底标题。当前引擎确实有调用点。 |
| [src/server/version-thumbnail.ts](../src/server/version-thumbnail.ts) | 按版本读取/生成缩略图：物化 Git 中该版文件，用 Chromium 的 file:// 打开静态 HTML，阻止外链并截图；串行/去重，当前不为 Vue/React 另行构建。 |
| [src/server/version-migration.ts](../src/server/version-migration.ts) | 一次性旧版本迁移能力：规划/应用 Git 保留引用、旧标题与截图搬迁，报告丢失或无法确认的提交。 |
| [src/server/git-guard.ts](../src/server/git-guard.ts) | 向应用 Git 仓库安装 reference-transaction hook，阻止删除/改写受保护历史引用。 |

## 图片与语音服务

| 文件 | 实际作用 |
| --- | --- |
| [src/server/binary.ts](../src/server/binary.ts) | 按字节签名识别 JPEG/PNG/WebP，避免把 URL 后缀或声明类型当成真实格式。 |
| [src/server/image-upload.ts](../src/server/image-upload.ts) | 处理图片 multipart 上传：来源、体积、字段、张数与类型检查，调用附件存储并返回安全视图。 |
| [src/server/image-files.ts](../src/server/image-files.ts) | 用 sharp 解码校验图片、限制尺寸、生成送模型的缩放图；管理原图/派生图的路径、原子保存、读取和清理。 |
| [src/server/attachment-store.ts](../src/server/attachment-store.ts) | 附件业务存储：校验应用归属，写 attachment 表并关联图片对象；按用户/应用授权读取原图或模型用派生图。 |
| [src/server/speech.ts](../src/server/speech.ts) | 解析/校验音频 multipart，解析 speech.transcribe 别名与密钥，请求上游 /audio/transcriptions；提供能力探测和转写文本。 |

## 模型配置与 AI SDK 调用适配

| 文件 | 实际作用 |
| --- | --- |
| [src/server/model.ts](../src/server/model.ts) | 创建应用时调用 route.classify 做结构化生成类型分类；fixture 模式用确定性规则，包含别名未配置的错误辅助判断。 |
| [src/server/models/admin.ts](../src/server/models/admin.ts) | 模型管理业务入口：校验载荷、产生不含密钥的管理视图，调用配置存储与上游模型列表探测；管理员鉴权由 API 路由执行。 |
| [src/server/models/store.ts](../src/server/models/store.ts) | 模型配置数据库读写：一致快照、revision 乐观并发、refreshEpoch、引用/必需槽位约束，密钥加密及初次环境配置导入。 |
| [src/server/models/registry.ts](../src/server/models/registry.ts) | 进程内模型注册表：解析别名与能力，缓存配置快照，处理 TTL/主动刷新/并发重载、短时降级和读取失败。 |
| [src/server/models/adapters.ts](../src/server/models/adapters.ts) | 把提供商/别名配置构造为 Vercel AI SDK 模型；三种 API 格式、密钥解析、自定义头、默认参数与思考 middleware。 |
| [src/server/models/secrets.ts](../src/server/models/secrets.ts) | 直接输入的模型密钥 AES-256-GCM 加解密；解析主密钥或生成本地 0600 主密钥文件。 |
| [src/server/models/probe.ts](../src/server/models/probe.ts) | 实时请求提供商 GET /models，按格式附鉴权，限制超时/数量，归一列表并脱敏错误。 |
| [src/server/models/errors.ts](../src/server/models/errors.ts) | 定义 ModelConfigInvalidError，让注册表区分配置已无效与数据库暂不可读。 |
| [src/server/models/responses-reasoning.ts](../src/server/models/responses-reasoning.ts) | 兼容 DeepSeek Responses 思考内容：转换 SSE 事件名/字段及非流式 JSON，使 AI SDK 能解析展示。 |

## 常驻 harness：高级内容

| 文件 | 实际作用 |
| --- | --- |
| [src/server/durable/harness-server.ts](../src/server/durable/harness-server.ts) | 常驻 Node HTTP 服务入口：开放 attach 协议，注册文件/只读 Git/构建/ask/联网工具，接入权限与预算门、会话/模型绑定、事件流和启动清理。 |
| [src/server/durable/harness.ts](../src/server/durable/harness.ts) | 装配 pi-durable Harness、扩展注册表、Node 执行环境与 PG 存储；设置失败后 withdraw、结构化报告，以及条目文本投影辅助函数。 |
| [src/server/durable/storage-pg.ts](../src/server/durable/storage-pg.ts) | 实现 pi-durable Storage 协议：会话/条目/任务/文档/提交等的 PG 存取、事务批写、扫描、迁移和单写 advisory lock；含测试重置入口。 |
| [src/server/durable/model-domain.ts](../src/server/durable/model-domain.ts) | 把产品 codegen.default 或显式覆盖转换成 pi-ai 模型绑定；处理格式、能力、思考/采样、凭据引用和持久运行描述，恢复时重建原绑定。 |
| [src/server/durable/effect-gate.ts](../src/server/durable/effect-gate.ts) | 把 conversation 绑定到 app/generation/execution；工具执行前检查执行状态与 authority，区分可读/可写，记录本轮源码是否已修改供 ask 使用。 |
| [src/server/durable/git-args.ts](../src/server/durable/git-args.ts) | 模型 Git 工具的只读子命令和参数白名单，拒绝改历史、改配置、重定向仓库和外联命令。 |
| [src/server/durable/protocol.ts](../src/server/durable/protocol.ts) | Next/harness attach 协议版本常量及历史说明；客户端用它拒绝不兼容的常驻服务。 |
| [src/server/durable/web-tool-result.ts](../src/server/durable/web-tool-result.ts) | 把联网结果同时包装为模型可读 JSON 文本与前端可渲染 details，保证实时和历史卡片一致。 |
| [src/server/durable/faux-model.ts](../src/server/durable/faux-model.ts) | 测试用可控假模型，生成等待/思考/指定工具行为，帮助验证取消、插话和重启。 |
| [src/server/durable/faux-fixture.ts](../src/server/durable/faux-fixture.ts) | 测试用完整文件生成假模型，按应用类型脚本化读取和写入模板，供隔离 E2E 验证整条产品链路。 |

## 联网搜索与图片素材

| 文件 | 实际作用 |
| --- | --- |
| [src/server/web-access/config.ts](../src/server/web-access/config.ts) | 联网服务商端点、单次请求超时/大小/结果上限，读取联网开关与服务配置。 |
| [src/server/web-access/types.ts](../src/server/web-access/types.ts) | 联网工具统一错误、ok/empty/error 返回结构，以及搜索、网页、图片候选与导入素材类型。 |
| [src/server/web-access/network.ts](../src/server/web-access/network.ts) | 目标 URL、DNS 和 IP 网段校验；阻止私网/保留地址等 SSRF 目标，区分可信设施和代理场景。 |
| [src/server/web-access/http.ts](../src/server/web-access/http.ts) | 基于 undici 的有限 HTTP 传输：DNS 地址固定、逐跳重定向校验、凭据剥离、超时/大小限制和代理处理。 |
| [src/server/web-access/providers.ts](../src/server/web-access/providers.ts) | 统一 SearXNG/Brave/Tavily 搜索，按当前实现的固定次序尝试可用源，并归因结果或处理可降级失败。 |
| [src/server/web-access/tavily.ts](../src/server/web-access/tavily.ts) | Tavily search/extract 接口适配，解析检索文本与图片字段。 |
| [src/server/web-access/read.ts](../src/server/web-access/read.ts) | 网页正文获取：Jina Reader 与 Tavily extract 的组合/回退，清洗并截断结果。 |
| [src/server/web-access/images.ts](../src/server/web-access/images.ts) | 从 Openverse/通用网页图片结果构建候选、稳定候选 ID，处理作者/来源/许可过滤。 |
| [src/server/web-access/import.ts](../src/server/web-access/import.ts) | 下载/校验候选图片，准备并持久化到应用素材目录，维护来源清单与署名页，复用已有素材。 |
| [src/server/web-access/tools.ts](../src/server/web-access/tools.ts) | 把检索/读网页/搜图/导图组装为业务操作与 AI SDK 工具，按开关提供能力，并保存会话候选供后续导入。 |

## 旧数据迁移支持

| 文件 | 实际作用 |
| --- | --- |
| [src/server/legacy-import.ts](../src/server/legacy-import.ts) | 校验经审查的旧用户/应用 JSON 快照：ID 精度、重复、日期、密码摘要和用户引用；本文件不连接旧 MySQL。 |
| [src/server/legacy-artifacts.ts](../src/server/legacy-artifacts.ts) | 规划/复制旧源码、dist、部署与本地封面到新 runtime；拒绝覆盖/危险文件，失败可回滚本次创建项。 |

## 配置、依赖和数据库迁移

| 文件 | 实际作用 |
| --- | --- |
| [package.json](../package.json) | 项目依赖及 npm 命令入口；先分清 dev、dev:web、build、type-check 和各档测试。 |
| [package-lock.json](../package-lock.json) | 锁定本平台实际安装的依赖树和完整性信息，供 npm ci 重现。 |
| [next.config.ts](../next.config.ts) | Next 构建/运行配置：开发输出目录、localhost 入口重定向、模板追踪、排除 runtime/环境文件和外部服务端依赖。 |
| [tsconfig.json](../tsconfig.json) | TypeScript 严格检查、JSX/模块解析、@/* 路径映射和生成类型范围；模板不由平台这份配置直接检查。 |
| [next-env.d.ts](../next-env.d.ts) | Next 自动生成的类型入口，引用路由等生成声明；不手写维护。 |
| [vitest.config.ts](../vitest.config.ts) | 划分 unit/integration/system 项目、运行次序、并发、别名、测试环境和资源清理 setup。 |
| [playwright.config.ts](../playwright.config.ts) | Chromium E2E 的目录、baseURL、启动前检查、超时、单 worker、报告和失败 trace。 |
| [compose.yaml](../compose.yaml) | 声明 Redis 与归档 MySQL 容器、回环端口和持久卷；不管理当前产品 Postgres。 |
| [.env.example](../.env.example) | 服务端配置样例及注释，不是实际密钥文件；运行时真实 .env 不列出。 |
| [.gitignore](../.gitignore) | 排除依赖、Next 生成物、环境配置、运行数据和测试输出。 |
| [migrations/001_initial.sql](../migrations/001_initial.sql) | 创建最初产品表、会话、旧 lease/限流、附件与模型配置；不创建 harness 转录存储。 |
| [migrations/002_drop_rate_limit.sql](../migrations/002_drop_rate_limit.sql) | 删除 PG 限流表，固定窗口已转到 Redis。 |
| [migrations/004_versioning.sql](../migrations/004_versioning.sql) | 创建历史版本/状态/分支表；当前运行时版本清单已转到 005，这些表用于旧数据参考/迁移。 |
| [migrations/005_version_ledger.sql](../migrations/005_version_ledger.sql) | 创建 version_record 版本台账及每轮最多一版约束。 |
| [migrations/006_harness_control.sql](../migrations/006_harness_control.sql) | 追加 authority、持久输入、execution、snapshot、attempt、question、transition、delivery、preview pointer、deployment，以及 generation 控制列。 |
| [migrations/007_harness_attempt_tool.sql](../migrations/007_harness_attempt_tool.sql) | 扩展 attempt.kind 检查约束，允许 tool 进入同一预算账本。 |

## 运行、检查与待执行迁移

| 文件 | 实际作用 |
| --- | --- |
| [scripts/durable-dev.ts](../scripts/durable-dev.ts) | npm run dev 的进程协调器：检查已有 PG，启动 harness/preview/Next，合并带前缀日志并统一退出；不会启动数据库。 |
| [scripts/preview.ts](../scripts/preview.ts) | 读取预览配置，启动独立静态服务，只允许绑定回环主机并处理退出信号。 |
| [scripts/durable-pg.ts](../scripts/durable-pg.ts) | 连接现有 PG，补建开发/测试的产品库与 harness 库并报告状态；不会启动/停止容器。 |
| [scripts/infra.ts](../scripts/infra.ts) | 建立 runtime 后执行 docker compose up -d --wait；实际会启动 compose 声明的服务，包括归档 MySQL 和 Redis。 |
| [scripts/migrate.ts](../scripts/migrate.ts) | 顺序执行未应用的 SQL 迁移，记录 checksum，拒绝修改已执行迁移。 |
| [scripts/initialize-models.ts](../scripts/initialize-models.ts) | 仅在模型配置仍为空时从环境配置初始化产品库模型，再关闭连接池。 |
| [scripts/admin.ts](../scripts/admin.ts) | 把指定已注册账号设为管理员，是会改变权限的操作脚本。 |
| [scripts/import-legacy.ts](../scripts/import-legacy.ts) | 将已审查 JSON 用户/应用快照导入新 PG，可同时复制审查过的旧产物；保留原 ID，并提升发号下界。 |
| [scripts/import-legacy-state.ts](../scripts/import-legacy-state.ts) | 把 legacy 当前预览和未发布源码导入不可变交付/封存草稿；默认预演，--apply 才落地，不补造 generation/版本。 |
| [scripts/durable-inspect.ts](../scripts/durable-inspect.ts) | 命令行读取 harness 会话/任务/转录，支持会话列表和完整输出，便于运行诊断。 |
| [scripts/check-ui-patterns.ts](../scripts/check-ui-patterns.ts) | 静态扫描 TSX，拦截已知 antd 失效表单绑定与废弃 API 写法。 |
| [scripts/check-e2e-patterns.ts](../scripts/check-e2e-patterns.ts) | 静态扫描浏览器测试，拦截写死地址、易误选的定位器和直接拼证据目录等写法。 |
| [scripts/verify-boundary.ts](../scripts/verify-boundary.ts) | 检查当前工作区对旧代码/项目外文件的改动是否符合冻结边界；已有用户改动也可能让它失败。 |
| [scripts/verify-infra.ts](../scripts/verify-infra.ts) | 真实读写验证产品 PG 和 Redis；可选重启本项目 Redis 验证持久化。 |
| [scripts/verify-restart.ts](../scripts/verify-restart.ts) | prepare/verify 两阶段保存和比较专用 fixture 样本：会话、转录、任务、预览、下载与重启后续轮。 |
| [scripts/test-database.ts](../scripts/test-database.ts) | 创建专用产品/harness 测试库，并在产品测试库执行迁移。 |
| [scripts/test-e2e.ts](../scripts/test-e2e.ts) | 隔离浏览器测试启动器：强制测试库、测试 Redis 与模型夹具，构建/启动 Next、预览和独立 harness，检查健康并清理进程。 |
| [scripts/hooks/pre-commit](../scripts/hooks/pre-commit) | 启用项目 Git hooks 后，提交前运行 check:fast；文件存在不代表 hooks 已启用。 |
| [scripts/hooks/pre-push](../scripts/hooks/pre-push) | 启用项目 Git hooks 后，推送前运行项目 type-check。 |

`db:import` 与 `legacy:import` 是尚未完成的生产切换入口；完成 `docs/plans/legacy-import.md` 后按 `scripts/README.md` 删除。

## 单元/本地文件与 HTTP 协议测试

| 文件 | 实际作用 |
| --- | --- |
| [tests/api-client.test.ts](../tests/api-client.test.ts) | 验证响应信封、非 JSON、业务失败和网络错误的客户端处理。 |
| [tests/artifacts.test.ts](../tests/artifacts.test.ts) | 验证静态源码有效性、ZIP、指定源码根、依赖拒绝、稳定部署地址及已有产物保留。 |
| [tests/build-feedback.test.ts](../tests/build-feedback.test.ts) | 验证可修源码失败/不可修环境失败分类与模型诊断文案。 |
| [tests/chat-inputs.test.ts](../tests/chat-inputs.test.ts) | 验证输入队列、流式落点、回执乱序、历史认领和分段渲染。 |
| [tests/delivery-store.test.ts](../tests/delivery-store.test.ts) | 验证不可变目录/manifest/摘要、危险文件拒绝、预览指针及固定交付解析。 |
| [tests/display.test.ts](../tests/display.test.ts) | 验证 UTC 存储时间解析、本地显示与未知类型回退。 |
| [tests/durable-harness-report.test.ts](../tests/durable-harness-report.test.ts) | 验证 1.4.0 结构化报告文案与失败后 withdraw 设置。 |
| [tests/element-selection.test.ts](../tests/element-selection.test.ts) | 验证可视化多选的结构、数量限制与定位上下文文本。 |
| [tests/generation-accounting.test.ts](../tests/generation-accounting.test.ts) | 验证停止原因分类及取消/abort 的优先级。 |
| [tests/generation-budget.test.ts](../tests/generation-budget.test.ts) | 验证环境配置的总时长、单次模型超时和重试参数默认值/合法范围；不是持久 attempt 预算测试。 |
| [tests/generation-feedback.test.ts](../tests/generation-feedback.test.ts) | 验证按键动作、进度状态归约、输入状态投影和中断提示。 |
| [tests/generation-instructions.test.ts](../tests/generation-instructions.test.ts) | 验证不同生成类型、模板、能力下的模型指令。 |
| [tests/heartbeat.test.ts](../tests/heartbeat.test.ts) | 验证长 HTTP 请求心跳、成功与失败响应仍可由客户端解析。 |
| [tests/image-attachments.test.ts](../tests/image-attachments.test.ts) | 验证粘贴/拖放/选择文件、附图限制、发送阻塞与附件 part 处理。 |
| [tests/legacy-artifacts.test.ts](../tests/legacy-artifacts.test.ts) | 验证旧产物/封面规划复制、缺失报告、安全边界和失败回滚。 |
| [tests/legacy-import.test.ts](../tests/legacy-import.test.ts) | 验证旧 JSON 快照的 bigint 精度、重复、日期与外键引用。 |
| [tests/model-config.test.ts](../tests/model-config.test.ts) | 验证模型配置 schema、格式选项、槽位能力、地址与密钥引用策略。 |
| [tests/model-routing.test.ts](../tests/model-routing.test.ts) | 验证 fixture 分类规则和本地模拟上游的结构化类型分类/错误。 |
| [tests/model-task-binding.test.ts](../tests/model-task-binding.test.ts) | 验证 AI SDK 模型绑定在一轮内冻结、下一轮读取新配置。 |
| [tests/password-config.test.ts](../tests/password-config.test.ts) | 验证新/旧密码、配置及来源边界，拒绝非法摘要和旧数据库连接。 |
| [tests/prompt-safety.test.ts](../tests/prompt-safety.test.ts) | 验证输入长度、空白、敏感词和注入模式。 |
| [tests/snowflake.test.ts](../tests/snowflake.test.ts) | 验证旧位布局、毫秒序列耗尽、时钟回拨和数值边界。 |
| [tests/static-templates.test.ts](../tests/static-templates.test.ts) | 验证静态模板骨架状态、文件写入、静态校验和导出元信息排除。 |
| [tests/templates.test.ts](../tests/templates.test.ts) | 验证模板初始化幂等、身份校验、旧工程保护和独立工程导出。 |
| [tests/test-database-url.test.ts](../tests/test-database-url.test.ts) | 验证测试连接地址只映射到专用测试库，拒绝未知库/查询覆盖。 |
| [tests/tool-call-view.test.ts](../tests/tool-call-view.test.ts) | 验证工具 part 转可读展示模型，含流式半截参数、错误和图片来源。 |
| [tests/version-summary.test.ts](../tests/version-summary.test.ts) | 验证短标题清洗、字符截断、助手总结与文件级兜底。 |
| [tests/voice-input.test.ts](../tests/voice-input.test.ts) | 验证录音格式选择、时间/错误提示及转写文字追加。 |
| [tests/web-access-http.test.ts](../tests/web-access-http.test.ts) | 验证联网传输超时/大小/状态、重定向、凭据去除和地址复验。 |
| [tests/web-access-images.test.ts](../tests/web-access-images.test.ts) | 验证图片签名、许可与来源、候选提取及图片导入行为。 |
| [tests/web-access-network.test.ts](../tests/web-access-network.test.ts) | 验证 URL/DNS/IP/端口、私网阻断与显式网段放行边界。 |
| [tests/web-access-providers.test.ts](../tests/web-access-providers.test.ts) | 验证搜索源可用性、降级、结果归因及认证失败处理。 |
| [tests/web-access-tools.test.ts](../tests/web-access-tools.test.ts) | 验证联网开关、工具 schema、搜索/读页/图片操作与返回结果。 |
| [tests/web-tool-result.test.ts](../tests/web-tool-result.test.ts) | 验证模型 JSON 文本与 UI details 同源，空结果/错误仍能渲染。 |
| [tests/workspace.test.ts](../tests/workspace.test.ts) | 验证真实本地文件读写、路径穿越/软链接拒绝及文件/目录配额。 |
| [tests/models/adapters.test.ts](../tests/models/adapters.test.ts) | 用本地协议端点验证三种 AI SDK 适配、流式/工具/结构化输出和参数。 |
| [tests/models/durable-model-domain.test.ts](../tests/models/durable-model-domain.test.ts) | 验证产品模型配置转 pi-ai 上游请求的格式、思考、请求头及凭据行为。 |
| [tests/models/probe.test.ts](../tests/models/probe.test.ts) | 验证 GET /models 鉴权、列表归一、超时/错误脱敏和数量限制。 |
| [tests/models/registry.test.ts](../tests/models/registry.test.ts) | 验证 TTL/refreshEpoch、一致快照、并发重载、失败退避与降级。 |
| [tests/models/responses-reasoning.test.ts](../tests/models/responses-reasoning.test.ts) | 验证 Responses 思考 SSE/JSON 改写，跨 chunk 行拼接和 done 事件保留。 |
| [tests/models/secrets.test.ts](../tests/models/secrets.test.ts) | 验证密钥加解密、随机 IV、主密钥格式、篡改拒绝与不泄露内容。 |

## 集成测试：真实测试库、Redis、harness 与并发

| 文件 | 实际作用 |
| --- | --- |
| [tests/integration/app-write-guard.test.ts](../tests/integration/app-write-guard.test.ts) | 验证新 authority、旧 lease、运行部署同时约束业务写和新生成。 |
| [tests/integration/ask-lifecycle.test.ts](../tests/integration/ask-lifecycle.test.ts) | 验证提问后封存/收束、回答消费和新 generation，以及封存失败交接。 |
| [tests/integration/attachment-store.test.ts](../tests/integration/attachment-store.test.ts) | 验证真实 multipart、附件数据库/文件落盘、读取权限和格式。 |
| [tests/integration/backend-invariants.test.ts](../tests/integration/backend-invariants.test.ts) | 验证终态/助手 ID/锁释放一致性、取消与成功回调竞态、过期写者及并发准入。 |
| [tests/integration/control-store.test.ts](../tests/integration/control-store.test.ts) | 验证 authority/epoch、心跳/交接、执行绑定、输入幂等/水位、问题和 attempt 状态。 |
| [tests/integration/deployment-record.test.ts](../tests/integration/deployment-record.test.ts) | 验证手动部署 requestId 幂等、每应用单 running、失败保留与超时回收。 |
| [tests/integration/download-delivery.test.ts](../tests/integration/download-delivery.test.ts) | 验证下载使用当前交付的源码快照，缺失不误退到活动草稿，legacy 才回退工作区。 |
| [tests/integration/durable-sleep.test.ts](../tests/integration/durable-sleep.test.ts) | 验证 sleeping 持久化/重启唤醒、存储 v1→v2 迁移及拒绝未知新版本。 |
| [tests/integration/execution-workspace.test.ts](../tests/integration/execution-workspace.test.ts) | 验证执行目录标识、模板/版本等基线、跨目录隔离、写入排空与快照封存。 |
| [tests/integration/feature-parity.test.ts](../tests/integration/feature-parity.test.ts) | 验证迁移后的应用类型、预览/部署、列表筛选排序及输入护轨等业务行为。 |
| [tests/integration/generation-budget.test.ts](../tests/integration/generation-budget.test.ts) | 验证持久 attempt 的模型24/工具400/自检2/平台3预算、修复轮数、deadline 和未知调用处理。 |
| [tests/integration/generation-lifecycle.test.ts](../tests/integration/generation-lifecycle.test.ts) | 验证生成准入/幂等/基线、取消草稿交接、原子发布、水位作废和恢复等生命周期。 |
| [tests/integration/generation-store.test.ts](../tests/integration/generation-store.test.ts) | 验证兼容任务存储的并发租约、取消保锁与过期任务清理。 |
| [tests/integration/git-guard.test.ts](../tests/integration/git-guard.test.ts) | 验证 reference-transaction hook 允许正常提交/切换并阻止历史破坏。 |
| [tests/integration/http.test.ts](../tests/integration/http.test.ts) | 验证真实 PG 下注册/登录、鉴权、来源、业务 HTTP 与旧库保护；文件里个别历史标题仍写 MySQL。 |
| [tests/integration/legacy-import.test.ts](../tests/integration/legacy-import.test.ts) | 验证 legacy 预览/草稿导入的 dry-run、apply 幂等、数据库/目录一致性且不造版本。 |
| [tests/integration/model-admin.test.ts](../tests/integration/model-admin.test.ts) | 验证模型管理接口登录/角色/来源限制、版本冲突及密钥不回显。 |
| [tests/integration/model-registry-multiprocess.test.ts](../tests/integration/model-registry-multiprocess.test.ts) | 验证多个进程在 TTL 或 refreshEpoch 后读取同一新配置。 |
| [tests/integration/model-store.test.ts](../tests/integration/model-store.test.ts) | 验证配置初始化、revision 并发、刷新序号、引用与必需别名保护。 |
| [tests/integration/preview-delivery.test.ts](../tests/integration/preview-delivery.test.ts) | 验证预览按不可变交付解析、固定 delivery URL、legacy 回退及文件边界。 |
| [tests/integration/publish-vue-build.test.ts](../tests/integration/publish-vue-build.test.ts) | 验证 legacy Vue 发布路径会按当前源码重建，不能沿用旧 dist 冒充当前结果。 |
| [tests/integration/rate-limit.test.ts](../tests/integration/rate-limit.test.ts) | 验证真实 Redis DB15 的固定窗口、不同策略、退款、TTL 与故障降级。 |
| [tests/integration/searxng-live.test.ts](../tests/integration/searxng-live.test.ts) | 验证本机 SearXNG 实例的实际搜索可用性，需要对应本地服务。 |
| [tests/integration/snowflake-ids.test.ts](../tests/integration/snowflake-ids.test.ts) | 验证注册/建应用 ID 精度、跨进程并发、事务回滚不复用与导入发号下界。 |
| [tests/integration/speech-transcribe.test.ts](../tests/integration/speech-transcribe.test.ts) | 验证转写接口权限、别名能力、multipart/格式限制与模拟上游请求。 |
| [tests/integration/steer-segments.test.ts](../tests/integration/steer-segments.test.ts) | 验证真实流中插话/排队/撤回、助手分段、取消/断连/收尾竞态及历史恢复。 |
| [tests/integration/storage-pg-conformance.test.ts](../tests/integration/storage-pg-conformance.test.ts) | 运行上游 Storage conformance suite，验证自定义 PG Storage 满足 SDK 协议。 |
| [tests/integration/template-generation.test.ts](../tests/integration/template-generation.test.ts) | 验证显式模板、自动类型路由、默认模板与冲突拒绝。 |
| [tests/integration/tool-output.test.ts](../tests/integration/tool-output.test.ts) | 验证 read/edit/listFiles/buildPreview 结果在实时流和历史投影中具有相同载荷。 |
| [tests/integration/version-api.test.ts](../tests/integration/version-api.test.ts) | 验证版本列表/搜索/diff/恢复接口和权限，恢复不追加版本。 |
| [tests/integration/version-generation.test.ts](../tests/integration/version-generation.test.ts) | 验证成功生成最多一版、标题兜底、无修改不造版本以及 Git 失败保草稿。 |
| [tests/integration/version-ledger.test.ts](../tests/integration/version-ledger.test.ts) | 验证台账幂等、每 generation 唯一、搜索/删除关联和有引用无行修复。 |
| [tests/integration/version-migration.test.ts](../tests/integration/version-migration.test.ts) | 验证旧提交引用、标题和截图迁移幂等，区分缺失和不可确认。 |
| [tests/integration/version-store.test.ts](../tests/integration/version-store.test.ts) | 验证 Git 版本构造、历史切换、提交集合/分支引用不被恢复操作破坏。 |
| [tests/integration/version-worktree.test.ts](../tests/integration/version-worktree.test.ts) | 验证从隔离执行目录提交，显式父版本、排除项和原索引不被污染。 |
| [tests/integration/durable-m1/ask.test.ts](../tests/integration/durable-m1/ask.test.ts) | 验证 harness ask 只在未改源码的绑定执行可用，提问后拒绝继续写。 |
| [tests/integration/durable-m1/attachments.test.ts](../tests/integration/durable-m1/attachments.test.ts) | 验证图像 content 进入模型上下文及非法内容拒绝。 |
| [tests/integration/durable-m1/build-tool.test.ts](../tests/integration/durable-m1/build-tool.test.ts) | 验证工具面、自检构建归属、成功结果转录与无绑定错误。 |
| [tests/integration/durable-m1/conversation.test.ts](../tests/integration/durable-m1/conversation.test.ts) | 验证会话隔离与后续模型上下文保留上一步工具结果。 |
| [tests/integration/durable-m1/disconnect.test.ts](../tests/integration/durable-m1/disconnect.test.ts) | 验证观察流断开不取消执行，重连读到完整结果且工具只执行一次。 |
| [tests/integration/durable-m1/effect-gate.test.ts](../tests/integration/durable-m1/effect-gate.test.ts) | 验证不同执行状态/epoch/过期权限的读写门、dirty 和 legacy 路径。 |
| [tests/integration/durable-m1/file-tools.test.ts](../tests/integration/durable-m1/file-tools.test.ts) | 验证原生文件工具分页读取、精确编辑、路径边界和多文件写入。 |
| [tests/integration/durable-m1/git-tool.test.ts](../tests/integration/durable-m1/git-tool.test.ts) | 验证只读 Git 子命令/参数白名单、越界配置拒绝和真实工具行为。 |
| [tests/integration/durable-m1/messages.test.ts](../tests/integration/durable-m1/messages.test.ts) | 验证用户条目落地、转录顺序、保留种类和未知会话拒绝。 |
| [tests/integration/durable-m1/model-config.test.ts](../tests/integration/durable-m1/model-config.test.ts) | 验证常驻进程下一轮切模型、在途冻结、密钥不泄露及重启保留原绑定。 |
| [tests/integration/durable-m1/restart.test.ts](../tests/integration/durable-m1/restart.test.ts) | 验证 SDK 重启后恢复任务，并避免重跑已中断的不安全工具。 |
| [tests/integration/durable-m1/route-auth.test.ts](../tests/integration/durable-m1/route-auth.test.ts) | 验证 attach API 的登录、创建者权限、appId 绑定与会话边界。 |
| [tests/integration/durable-m1/steer.test.ts](../tests/integration/durable-m1/steer.test.ts) | 验证插话在步骤边界进入真实上下文和正确转录位置。 |
| [tests/integration/durable-m1/web-tools.test.ts](../tests/integration/durable-m1/web-tools.test.ts) | 验证联网开关决定真实注册工具面，并声明 replay 策略。 |

## 系统测试：真实 Docker / Chromium

| 文件 | 实际作用 |
| --- | --- |
| [tests/system/build.test.ts](../tests/system/build.test.ts) | 验证真实容器不执行生成安装脚本、不读取平台环境、构建阶段断网和超时文案。 |
| [tests/system/preview-rebuild.test.ts](../tests/system/preview-rebuild.test.ts) | 验证现有源码缺产物时重建预览、静态类型处理与权限/运行态限制。 |
| [tests/system/preview.test.ts](../tests/system/preview.test.ts) | 验证真实预览 HTTP、编辑桥接多选/移除、安全路径及 Chromium 封面 PNG。 |
| [tests/system/template-build.test.ts](../tests/system/template-build.test.ts) | 验证 Vue/React 模板真实类型检查与构建，改锁/非法依赖/类型错误不覆盖旧产物。 |
| [tests/system/web-access-images.test.ts](../tests/system/web-access-images.test.ts) | 验证导入素材进入产物/ZIP/署名页，并能被真实浏览器加载。 |

## 浏览器 E2E：从用户操作验证

| 文件 | 实际作用 |
| --- | --- |
| [tests/e2e/admin-parity.spec.ts](../tests/e2e/admin-parity.spec.ts) | 验证用户/应用管理、创建者与管理员编辑路径、权限提示、字段和分页。 |
| [tests/e2e/app-edit-publish-verify.spec.ts](../tests/e2e/app-edit-publish-verify.spec.ts) | 验证生成→下载源码快照→幂等部署→版本恢复的完整交付流程。 |
| [tests/e2e/ask-question-verify.spec.ts](../tests/e2e/ask-question-verify.spec.ts) | 用真实 ask 工具与夹具模型验证提问后未改源码、回答从草稿开启新 generation、重复回答拒绝，并保存浏览器证据。 |
| [tests/e2e/chat-composer.spec.ts](../tests/e2e/chat-composer.spec.ts) | 验证输入可见性、发送/快捷键、队列/撤回/重发、工具展示、断流/终态和滚动行为。 |
| [tests/e2e/chat-images.spec.ts](../tests/e2e/chat-images.spec.ts) | 验证选图上传、消息缩略图放大、非法文件提示与生成中附图插话。 |
| [tests/e2e/chat-initial-prompt.spec.ts](../tests/e2e/chat-initial-prompt.spec.ts) | 验证新应用初始需求仅自动发送一次，已有任务/历史或非创建者不重复提交。 |
| [tests/e2e/chat-layout.spec.ts](../tests/e2e/chat-layout.spec.ts) | 验证固定顶栏、聊天视口、分栏拖动/持久化、预览收起展开与手机布局。 |
| [tests/e2e/chat-parity.spec.ts](../tests/e2e/chat-parity.spec.ts) | 验证公开详情、创建者/管理员操作、可视化元素多选、历史与预览/下载/部署联动。 |
| [tests/e2e/chat-preview-rebuild.spec.ts](../tests/e2e/chat-preview-rebuild.spec.ts) | 验证缺预览时自动重建、历史失败提示与已有可用预览的关系。 |
| [tests/e2e/chat-voice.spec.ts](../tests/e2e/chat-voice.spec.ts) | 验证录音→转写追加文字，以及未配置时按钮禁用。 |
| [tests/e2e/dev-warnings.spec.ts](../tests/e2e/dev-warnings.spec.ts) | 在真实 Next 开发构建中验证普通页/管理页和弹窗没有运行告警。 |
| [tests/e2e/home-parity.spec.ts](../tests/e2e/home-parity.spec.ts) | 验证模板下拉、创建提交参数、分页、键盘/触屏卡片操作与 reduced-motion。 |
| [tests/e2e/model-manage.spec.ts](../tests/e2e/model-manage.spec.ts) | 验证管理员编辑提供商/槽位、密钥不回显、冲突保表单、刷新生效与权限。 |
| [tests/e2e/platform-origin.spec.ts](../tests/e2e/platform-origin.spec.ts) | 验证 localhost 入口跳转、注册/登录会话和来源拒绝。 |
| [tests/e2e/platform.spec.ts](../tests/e2e/platform.spec.ts) | 平台基本全流程、管理员访问及多种生成类型的实际页面。 |
| [tests/e2e/version-panel.spec.ts](../tests/e2e/version-panel.spec.ts) | 验证版本列表、当前/旧版本标记、缩略图、diff、恢复确认与面板交互。 |
| [tests/e2e/version-delivery-verify.spec.ts](../tests/e2e/version-delivery-verify.spec.ts) | 用真实 Next/harness/预览与夹具模型生成两版多文件应用，验证恢复不加版本、外部 CSS/JS、下载和部署都使用对应交付，并留存证据。 |
| [tests/e2e/vue-generation.spec.ts](../tests/e2e/vue-generation.spec.ts) | 验证 Vue 自动生成/构建后，预览真实页面且点击交互可用。 |

## 测试辅助代码：不是产品功能

| 文件 | 实际作用 |
| --- | --- |
| [tests/server-only.ts](../tests/server-only.ts) | Vitest 将 server-only 映射到此空模块，让测试可导入服务端文件。 |
| [tests/unit-boundaries.ts](../tests/unit-boundaries.ts) | 单元测试 setup：阻止误用数据库/Redis/子进程/浏览器等外部资源，提示移入正确档位。 |
| [tests/integration-resources.ts](../tests/integration-resources.ts) | integration/system 结束后关闭限流 Redis 客户端。 |
| [tests/test-database-url.ts](../tests/test-database-url.ts) | 把允许的产品/执行库 URL 规范为专用测试库，拒绝歧义连接参数。 |
| [tests/integration/durable-m1/support.ts](../tests/integration/durable-m1/support.ts) | 分配端口、启停假模型 harness、探测 PG/健康、读状态和等待事件的集成测试助手。 |
| [tests/integration/support/model-registry-process.ts](../tests/integration/support/model-registry-process.ts) | 跨进程注册表测试的子进程入口，通过 stdin 指令解析/修改配置并返回结果。 |
| [tests/e2e/support/app-origin.ts](../tests/e2e/support/app-origin.ts) | 统一读取平台与预览来源，测试换端口时不必改每个 spec。 |
| [tests/e2e/support/evidence.ts](../tests/e2e/support/evidence.ts) | 按实际日期生成仓库统一证据目录/截图路径。 |
| [tests/e2e/support/model-config-fixtures.ts](../tests/e2e/support/model-config-fixtures.ts) | 建立测试库连接，提供设置管理员、清空/种入模型配置和读取提供商请求头的夹具助手。 |
| [tests/e2e/support/require-server.ts](../tests/e2e/support/require-server.ts) | Playwright globalSetup：检查指定平台已启动，缺服务时报可操作的错误，不负责起服务。 |

## 生成应用模板：与平台自身的 Next 应用分开理解

| 文件 | 实际作用 |
| --- | --- |
| [templates/html/1.0.0/index.html](../templates/html/1.0.0/index.html) | 单文件静态网站初始骨架：布局/内嵌样式与空主内容区，供模型继续填充。 |
| [templates/html/1.0.0/AGENTS.md](../templates/html/1.0.0/AGENTS.md) | 该模板给生成模型的修改说明与限制。 |
| [templates/multi-file/1.0.0/index.html](../templates/multi-file/1.0.0/index.html) | 多文件静态模板入口，引用独立 CSS/JS 与内容挂载点。 |
| [templates/multi-file/1.0.0/css/style.css](../templates/multi-file/1.0.0/css/style.css) | 多文件模板的响应式视觉样式。 |
| [templates/multi-file/1.0.0/js/main.js](../templates/multi-file/1.0.0/js/main.js) | 多文件模板示例交互：创建内容卡片并填当前年份。 |
| [templates/multi-file/1.0.0/AGENTS.md](../templates/multi-file/1.0.0/AGENTS.md) | 给模型的多文件静态开发说明。 |
| [templates/react-ts/1.0.0/index.html](../templates/react-ts/1.0.0/index.html) | Vite React 工程 HTML 与 React 挂载节点。 |
| [templates/react-ts/1.0.0/package.json](../templates/react-ts/1.0.0/package.json) | React 模板允许依赖/精确版本及独立运行脚本。 |
| [templates/react-ts/1.0.0/package-lock.json](../templates/react-ts/1.0.0/package-lock.json) | React 模板固定依赖树；平台构建会核对原版锁文件。 |
| [templates/react-ts/1.0.0/tsconfig.json](../templates/react-ts/1.0.0/tsconfig.json) | 生成 React 工程自身的 TypeScript 检查配置。 |
| [templates/react-ts/1.0.0/vite.config.ts](../templates/react-ts/1.0.0/vite.config.ts) | React Vite 插件、相对资源 base 等构建设置。 |
| [templates/react-ts/1.0.0/src/main.tsx](../templates/react-ts/1.0.0/src/main.tsx) | 加载样式并将 App 挂载到浏览器 root 节点。 |
| [templates/react-ts/1.0.0/src/App.tsx](../templates/react-ts/1.0.0/src/App.tsx) | “今日计划”示例主界面：输入任务、筛选、列表、剩余数量与错误提示。 |
| [templates/react-ts/1.0.0/src/components/TaskItem.tsx](../templates/react-ts/1.0.0/src/components/TaskItem.tsx) | 单个任务的完成切换和删除，通过 props/回调交给父级更新。 |
| [templates/react-ts/1.0.0/src/hooks/useTasks.ts](../templates/react-ts/1.0.0/src/hooks/useTasks.ts) | React 任务状态 Hook：本地存储恢复/保存、新增/切换/删除、筛选和派生统计。 |
| [templates/react-ts/1.0.0/src/types/task.ts](../templates/react-ts/1.0.0/src/types/task.ts) | Task 与筛选模式的 TypeScript 类型。 |
| [templates/react-ts/1.0.0/src/style.css](../templates/react-ts/1.0.0/src/style.css) | React 示例任务应用的完整样式。 |
| [templates/react-ts/1.0.0/README.md](../templates/react-ts/1.0.0/README.md) | 生成工程的本地安装/运行说明。 |
| [templates/react-ts/1.0.0/AGENTS.md](../templates/react-ts/1.0.0/AGENTS.md) | 给模型的工程阅读、入口与依赖约束。 |
| [templates/vue-ts/1.0.0/index.html](../templates/vue-ts/1.0.0/index.html) | Vite Vue 工程的 HTML 入口和挂载节点。 |
| [templates/vue-ts/1.0.0/package.json](../templates/vue-ts/1.0.0/package.json) | Vue 模板允许依赖/精确版本及独立运行脚本。 |
| [templates/vue-ts/1.0.0/package-lock.json](../templates/vue-ts/1.0.0/package-lock.json) | Vue 模板固定依赖树，平台按原版核对。 |
| [templates/vue-ts/1.0.0/tsconfig.json](../templates/vue-ts/1.0.0/tsconfig.json) | 生成 Vue 工程的 TypeScript/vue-tsc 配置。 |
| [templates/vue-ts/1.0.0/vite.config.ts](../templates/vue-ts/1.0.0/vite.config.ts) | Vue Vite 插件、相对资源 base 等构建设置。 |
| [templates/vue-ts/1.0.0/src/main.ts](../templates/vue-ts/1.0.0/src/main.ts) | 加载样式，createApp(App) 挂载 Vue 应用。 |
| [templates/vue-ts/1.0.0/src/App.vue](../templates/vue-ts/1.0.0/src/App.vue) | Vue“今日计划”示例：输入、筛选、任务列表与完成切换。 |
| [templates/vue-ts/1.0.0/src/components/TaskItem.vue](../templates/vue-ts/1.0.0/src/components/TaskItem.vue) | 单个任务展示，通过 toggle/remove emit 通知父级。 |
| [templates/vue-ts/1.0.0/src/composables/useTasks.ts](../templates/vue-ts/1.0.0/src/composables/useTasks.ts) | Vue 任务响应式状态、computed 筛选统计、watch 本地存储和增删。 |
| [templates/vue-ts/1.0.0/src/types/task.ts](../templates/vue-ts/1.0.0/src/types/task.ts) | Vue 示例的任务/筛选类型。 |
| [templates/vue-ts/1.0.0/src/style.css](../templates/vue-ts/1.0.0/src/style.css) | Vue 示例任务应用的视觉样式。 |
| [templates/vue-ts/1.0.0/README.md](../templates/vue-ts/1.0.0/README.md) | 生成 Vue 工程的独立运行说明。 |
| [templates/vue-ts/1.0.0/AGENTS.md](../templates/vue-ts/1.0.0/AGENTS.md) | 给模型的 Vue 工程开发与依赖约束。 |

## 推荐学习路线：用完成标准决定进度

以下按每天约 1–2 小时给出顺序，不保证固定几天掌握。如果 React 也没学过，先走第 0 步；如果你已经能写组件、表单和 Hook，可直接从第 1 步开始。

| 阶段 | 只学这些 | 在项目里的练习 | 通过标准 |
| --- | --- | --- | --- |
| 0：React/TS 基础 | JSX、props、useState、事件、列表 key、受控输入、async/await、联合类型；随后学 useEffect 清理 | 在独立练习副本里读 React 模板 App/TaskItem/useTasks，改任务过滤或表单提示；正式模板有锁文件约束，不随意加依赖 | 能说清状态由谁持有、点击如何更新、刷新为什么还能恢复 |
| 1：Next 最小骨架 | App Router、page/layout、动态参数、Link/useRouter、Server/Client 边界 | 阅读首页→编辑页；调整编辑页本地展示，如“名称已修改”的未保存提示 | 能把文件路径映射到 URL，解释 use client 和 params 的处理 |
| 2：一条 HTTP 链路 | fetch、GET/POST、JSON、状态码、Zod 运行时校验、错误处理 | 追踪应用改名；在测试环境验证成功/空白/超长/无权限，观察 Network 面板 | 能从按钮追到具体 UPDATE，再追到返回数据和页面刷新 |
| 3：会话与权限 | Cookie、HttpOnly、服务端会话、所有者/管理员、来源检查 | 追踪登录；用独立普通/管理员账号观察同一应用操作差异 | 能解释为什么修改 useAuth 或手动构造请求不能获得权限 |
| 4：数据库和持久化 | Drizzle 的 select/update/where、bigint、事务/行锁、追加迁移 | 先给应用列表加一个利用已有字段的过滤；再在隔离练习库尝试贯穿页面/接口/表的可选字段 | 能区分类型定义、SQL 迁移和真实数据，不把改 schema.ts 当成已改数据库 |
| 5：流式 UI | ReadableStream/SSE 基础、useChat、消息 part、轮询补偿、AbortController | 先只调整工具结果/用量等只读展示，读 generation-feedback 与 use-generation-sync | 能区分浏览器断流、显式取消和后台终态，不因断流立刻标失败 |
| 6：AI 执行可靠性 | 幂等、epoch、防旧执行写入、输入水位、不可变快照、发布事务 | 配合现有集成测试追踪一次生成和取消，再考虑改控制协议 | 能解释旧执行为何不能覆盖新轮，以及失败草稿为何不等于当前预览 |

## 每次开发采用同一个小循环

1. **只选一件能看见结果的改动。** 写清正常结果和一条失败结果。例如“改名后重新进入仍显示新名称；空白名称被拒绝”。
2. **先画 5 个点。** 哪个组件、哪个请求、哪个路由分支、哪个服务函数、哪张表；纯展示改动不硬加数据库步骤。
3. **先预测再改。** 写下数据形状、执行位置和预期响应，打开浏览器 Network 与正确进程日志验证预测。
4. **实现一个概念。** 初期每次控制在 1–3 个业务文件；复杂契约变更需要更多文件时，先确认边界再动手，不为凑数量拆代码。
5. **检查真实结果。** 读回保存值、刷新页面，验证错误与权限。只读代码不代表行为已验证，类型通过也不代表表单提交成功。
6. **按风险验证。** 使用项目 type-check 和相关测试；涉及页面功能按仓库 verify-paimeng 流程做浏览器验收，涉及 TSX/antd 还跑真实 dev 告警门。无需每次都跑整套数据库/容器测试。
7. **用自己的话复述。** 能说清“输入在哪验证、谁有权写、失败怎么显示、数据在哪持久化”，才算这次改动同时学到了知识。

可以这样要求 AI 协助：

> 这次只处理一个具体功能。先指出需要改的文件和相关函数，解释浏览器与服务端之间的数据流。把框架知识限制在本次要用的部分；修改后让我先预测请求/响应，再给验证步骤。完成后列三个问题检查我是否理解。

不用强迫自己先独立写完整模块，也不把“AI 已经改好”当成“我已经学会”。关键是你能预测行为、检查改动和解释错误。

## 第一轮建议安排

- 第一次：用浏览器和编辑器完整追踪“修改应用名称”，暂不改行为。重点读编辑页、api.ts、业务 route、http.ts、auth.ts、updateApp、db/schema。
- 第二次：做一个不改数据库的表单体验练习，如未保存名称提示；理解 state、表单当前值和从服务端读回的 app 值的区别。
- 第三次：追踪登录/退出，理解前端用户 Context 如何刷新以及真正权限检查在哪里。
- 第四次：利用已有字段做列表过滤练习，理解查询参数、分页和 SQL 条件。
- 普通 CRUD 熟悉后：再追踪生成接口与消息流。control-store/storage-pg 不作为 Next 入门材料，它们解决的是持久执行和并发协议。

## 常用验证入口

```bash
# 在 paimeng-ai-code-agent/ 中执行；这里列用法，不表示已代你运行
npm run type-check
npm run check:ui
npm run check:e2e

# 不依赖真实数据库的相关单元测试举例
npm test -- tests/api-client.test.ts tests/display.test.ts

# 已按仓库流程准备隔离测试环境后，运行指定浏览器场景
npm run test:e2e:isolated -- tests/e2e/admin-parity.spec.ts

# TSX/antd 交互变更的开发告警门
npm run test:e2e:dev
```

开发启动用 npm run dev；dev:web 仅起 Next。数据库准备命令不是前端热更新。不要把迁移/导入/设管理员脚本作为随意试运行的学习命令；相应练习应在专用测试环境执行。

## 官方资料按需阅读

- [React Learn](https://react.dev/learn)：Quick Start、状态、事件、共享状态、自定义 Hook。
- [Next App Router 入门](https://nextjs.org/docs/app/getting-started)：先 Project Structure、Layouts and Pages、Server and Client Components、Route Handlers；学会普通请求链路后再读缓存和进阶渲染。
- [Next 官方课程](https://nextjs.org/learn)：补足完整 CRUD/鉴权场景，概念映射回本项目，不把课程版本的 API 原样套过来。
- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html)：对象、联合类型、缩小类型与泛型，随遇到的代码补。
- [Drizzle 查询文档](https://orm.drizzle.team/docs/select)：从 select/update/where 读起，再学事务。

项目当前声明 Next ^16.4.2，React 19.2.8。实现细节以当前已安装 Next 文档 `node_modules/next/dist/docs/`、package-lock 和实际源码为准，旧教程里的 Pages Router/getServerSideProps 等不要直接混入当前 App Router。
