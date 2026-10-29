# 聊天页布局：顶栏固定、预览可拖可收、提示进对话流、手机端预览

> **Archived 2026-10-29.** Historical implementation record. Current product behavior and boundaries are in the [implementation contract](../../implementation-contract.md) and [README](../../README.md); this file preserves the plan and its verification evidence as written at the time.

一句话：**「网页展示」从一块写死 2:3 比例的静态面板，变成可拖宽、可收起、可切手机端的侧栏；页面顶部的独立提示条取消，进对话流；顶部菜单全站钉住。**

## 现状（已核对代码）

1. **顶栏随页面滚走。** 全站布局在 `providers.tsx:16`：`Layout.Header` 在正常文档流里，长页面往下滚它就没了。聊天页自身锁了一屏（`chat.css:6`，`height: calc(100dvh - 64px)`），但页脚仍在文档末尾，整页还有一小段可滚。
2. **两栏比例写死 2:3，不可拖、不可收。** `.chat-panel` flex:2（`chat.css:34`）、`.preview-panel` flex:3（`chat.css:244`）。首次进入还没有预览的应用时，右侧只放一个「网站文件生成完成后将在这里展示」的占位（`page.tsx:779`），白占五分之三的屏。
3. **页面级提示是独立条条。** 生成失败/断流/请求错误、构建与部署进行中、对话历史读不出，三种提示都渲染在工具栏与两栏之间（`page.tsx:651-653`），悬在整个页面上方，与对话内容割裂。
4. **预览只有电脑端一种宽度。** iframe 铺满 `preview-panel`，没法看手机上的效果。
5. **全仓库没有任何 localStorage 布局偏好**，偏好持久化是本轮新引入的事。

## 本轮范围

只改客户端：`providers.tsx`、`globals.css`、`page.tsx`、`chat.css` 与对应 e2e。不动服务端，不动 `/app/edit` 编辑页。

### 1. 顶部菜单全站固定

- `.site-header` 加 `position: sticky; top: 0; z-index: 100`（背景本就是不透明白，无需加视觉）。
- `html` 与 `body` 的 `overflow-x: hidden` 改成 `overflow-x: clip`（`globals.css:1`）：hidden 会把 body 变成滚动容器，sticky 元素被困在里面永远不激活；clip 视觉效果一样，但不建滚动容器。
- 聊天页不再渲染页脚：`providers.tsx` 按 `pathname.startsWith('/app/chat/')` 跳过 `Layout.Footer`，聊天页从此一屏锁死、整页零滚动；其余页面页脚照旧。
- 聊天页高度按顶栏实际占位（64px 高 + 1px margin-bottom）收紧为 `calc(100dvh - 65px)`，保证 `window.scrollY` 恒 0（composer 用例已有这条断言）。

### 2. 两栏可拖拽、「网页展示」可收起

- 结构改为：`.chat-panel`（flex-basis 按宽比）+ `.chat-divider`（拖拽条）+ `.preview-panel`（flex:1）。收起时拖拽条不渲染、预览区 `display: none` 隐藏，对话区占满整行。
- 拖拽：`pointerdown` 后 `setPointerCapture`，拖动中 body 置 `col-resize` 光标并禁文本选择，松手把宽比写进 localStorage。捕获握在拖拽条自己手上，指针扫过 iframe 也不丢事件（iframe 会吞掉未捕获的鼠标事件，这是必须用指针捕获的原因）。
- 宽比夹取：对话区与预览区各不小于 300px；存 0–1 小数（对话区占比），默认 0.4（对齐今天的 2:3）。
- **收起是隐藏，不是卸载**：预览区用 `display: none` 保留，iframe 不重新挂载。卸载会让预览回到首页，多页原型里点开的页面与可视化编辑的浏览位置都会丢。
- 只在 ≥1025px 生效；≤1024px 维持现有上下堆叠、各 50vh，拖拽条隐藏，收起仍可用。
- 收起入口在预览栏标题行（「收起」按钮，挨着可视化编辑）；展开入口在聊天工具栏（「网页展示」按钮，收起后它是唯一入口，窄屏同样可用）。两个入口控同一个状态。
- 存好的宽比在挂载后的 effect 里应用（不在首渲染读 localStorage，避免 hydration 不一致）。

### 3. 没有预览时默认收起，预览出现自动展开

- 展开状态三态：`null`（用户没动过）→ 跟着 `canPreview` 走，有预览就展开、没预览就收起；`true`/`false`（用户点过）→ 以用户为准，进 localStorage。
- 首次对话场景：进页面无预览 → 收起，对话区占满；第一轮生成结束 `previewUrl` 就位 → 自动展开，用户当场看到成果。若用户在看到预览前就手动收起过，不再强行展开。
- 重建预览（源码在、预览丢）场景同理：重建期间收起，重建完成自动展开。

### 4. 报错与提示进对话流

- 现有三处页面级 Alert（`page.tsx:651-653`）：生成失败/断流/请求错误（可关闭）、构建与部署进行中（含已用时秒数）、对话历史读不出，全部从工具栏下方移进 `.messages-inner` 末尾，作为对话流里的系统条目渲染（antd Alert 全宽、下边距 14px，关闭行为与文案不变）。
- 渲染顺序与现状一致：错误 → 构建/部署进度 → 历史读取失败；排在最后一条消息之后、未交付的输入气泡之前。
- 生成中徽标、memory-hint、generating-hint、BuildProgress 时间线本来就在对话面板内，不动；输入区上方的选中元素提示（selected-element-alert）不动，它贴着输入框，不是被诟病的页面级条条。

### 5. 手机端预览

- 预览栏新增切换按钮：当前电脑端 → 按钮是「手机端」；当前手机端 → 按钮是「电脑端」。文案永远表示要切过去的目标；设备只决定首次默认。
- 首次默认按设备：视口宽 < 768px 记手机端，否则电脑端；用户选过则以 localStorage 为准。
- 手机端形态：`preview-live` 里居中一个 390px 宽（`max-width: 100%`）的圆角描边框，iframe 填满框内；电脑端维持现状铺满。
- **两种模式共用同一个 iframe 元素**，只换外层容器的类名，不写两个 JSX 分支。切换时不重建、不重载：预览停在原来那一页，可视化编辑的选中状态也不受影响。
- 没有预览时面板已默认收起，切换按钮只在面板展开时出现。

## 单元与顺序

| # | 内容 | 主要文件 | 验收 |
| --- | --- | --- | --- |
| U1 | 先实测 sticky，再按结论改顶栏、overflow、页脚与高度 | `globals.css`、`providers.tsx`、`chat.css` | 实测记录写进实施记录（改前改后各滚一屏）；顶栏钉在视口顶；聊天页 `window.scrollY` 恒 0；composer 四组窄窗口用例不回归 |
| U2 | 拖拽条 + 收起/展开 + 宽比持久化 | `page.tsx`、`chat.css` | 拖动改变两栏宽度且刷新后记住；两侧各不小于 300px；收起后对话区占满、iframe 不重载，工具栏按钮可展开；≤1024px 无拖拽条但可收起 |
| U3 | 默认收起与自动展开 | `page.tsx` | 无预览进入即收起；previewUrl 就位后自动展开；手动收起过后不再自动展开 |
| U4 | 提示进对话流 | `page.tsx`、`chat.css` | 三类提示渲染在 `.messages` 内；工具栏下方再无 Alert；既有断言改写后全过 |
| U5 | 手机端切换 | `page.tsx`、`chat.css` | 按钮文案=目标模式；手机端框宽 390 且居中；选择刷新后保持；电脑端铺满不变；切换前后 iframe 是同一个元素，预览不重载 |
| U6 | 测试与证据 | 既有 spec 改写 + 新增用例 | 见「受影响的既有断言」与验证门禁 |

## 受影响的既有断言

- `chat-parity.spec.ts:134`「网站文件生成完成后将在这里展示」可见：无预览应用现在默认收起，占位不可见。改写为：默认收起，点工具栏「网页展示」后见占位。
- `chat-preview-rebuild.spec.ts:31-34`「正在重建预览...」在预览面板里：收起期间不可见。改写为：断言对话流里的构建提示（「正在构建预览：已用时」），重建完成后预览自动展开、iframe src 正确。
- `chat-parity.spec.ts:92` 历史读不出的文案断言：位置变了但 `getByText` 仍可见，预期不用改，跑了确认。
- `chat-composer.spec.ts:30-39` 视口扫掠（含 scrollWidth 不溢出）：拖拽条与收起不得引入横向溢出；`chat-composer.spec.ts:848` `pv=1` 预览刷新路径不受容器改造影响。

新增用例（挂在聊天布局 spec 里，复用现有 mock 手法）：

- 顶栏 sticky：任一可滚动页面（应用列表页）滚一屏后 `.site-header` 的 boundingBox 顶部仍为 0。
- 拖拽：抓拖拽条横移 200px，对话区与预览区宽度按预期变化，刷新后保持。
- 收起/展开往返：预览栏「收起」→ 预览区消失、对话区占满；工具栏「网页展示」→ 恢复原宽比。
- 默认收起与自动展开：无预览进入即收起；mock 出 previewUrl 后自动展开。
- 手机端：1280 宽默认电脑端铺满；点「手机端」后框宽 390 且按钮变「电脑端」；375 宽默认手机端；刷新保持选择。
- 不重载：在预览里点进第二页（mock 一个两页的 HTML），收起再展开、切手机端再切回，预览仍在第二页，iframe 的 `contentWindow` 同一个。

## 开放问题（已按默认拍板，评审可推翻）

1. **展开入口放聊天工具栏**（全尺寸可用）。备选：收起后右侧留一条窄竖条（IDE 侧栏风格），但堆叠布局下没有「右侧」，窄屏还得另做入口。
2. **手机端预览记住用户选择**（localStorage，跨应用共享）。备选：每次进入按设备重置。
3. **手机端只做 390px 圆角描边框**，不做刘海、Home 条等拟物装饰。
4. **宽比与收起状态按浏览器记一份**（跨应用共享），不按应用记。
5. **构建/部署的进行中提示也进对话流**：用户原话是「报错信息或提示信息」，它属于提示。

## 验证门禁

`type-check` → `npm test`（纯客户端改造，单测预期零变化）→ `verify.mjs` 逐个跑 `chat-composer`、`chat-parity`、`chat-preview-rebuild`、`version-panel`（预览刷新路径穿过面板容器，必须过），证据归档 `.pi/skills/verify-paimeng-agent/evidence/<timestamp>/`；`home-parity` 对照跑一次，预存 5 败之外不得新增。端口沿用 `E2E_APP_PORT=3020 E2E_PREVIEW_PORT=3021`。

关键旅程：

- 全新应用首次进入：预览收起、对话区占满；发一句话生成，结束后预览自动展开出 iframe。
- 拖动分界线：两栏宽度变化，刷新后保持；收起再展开，宽比仍在。
- 生成失败：错误出现在对话流末尾、可关闭；页面顶部再无独立条。
- 电脑端点「手机端」：预览变 390px 居中框、按钮变「电脑端」，刷新后仍是手机端。
- 375px 宽的真手机进页面：默认就是手机端预览。

## 评审裁决（2026-10-23）

六条已定，前三项改了计划，后三项保留原设计：

- **收起与切换不卸载 iframe**（f1，已并入 §2、§5 与 U2、U5 验收）。
- **U1 先实测 sticky 再决定改动范围**（f4，已并入 U1 与验证门禁）。
- 固定全站顶栏、聊天页去掉页脚做到零滚动（f4b 默认）。
- **自动展开仍按「预览地址出现」触发**（f2 保留）：后台自动重建与版本回退也会弹开面板，这是已知代价，不再加「只认本轮生成结束」的条件。
- **错误只进对话流，不主动把对话滚到底**（f3 保留）：用户翻着历史时可能看不见新失败，这是已知代价。
- **拖拽条只做鼠标**（f5 保留）：不加 `role="separator"`、方向键与 `pointercancel` 兜底，窄屏用户用收起与展开。
- 首帧宽比跳动（5.1）随之保留：仍在挂载后的 effect 里读 localStorage。

## 实施记录（按实际代码回填）

U1–U6 已落地。实施中按计划外的一条用户意见又改了一次提示的形态：

- **sticky 实测**：`html` 与 `body` 的 `overflow-x: hidden` 确实是成因（body 因此成为滚动容器）。改成 `clip` 后顶栏钉住。聊天页去页脚后整页零滚动，`document.documentElement.scrollHeight <= innerHeight` 在 e2e 里钉住。顺手删掉 `globals.css` 里被 `chat.css` 盖死的旧两栏 grid 与 ≤900px 高度规则。
- **收起是隐藏**：预览区留在 DOM 里用 `display: none` 收起，手机端与电脑端共用同一个 iframe。e2e 在 iframe 元素上打标记，收起、展开、切两轮之后标记还在，证明没有重建。
- **自动展开按预览地址出现**（f2 保留）：后台重建和版本回退也会弹面板，已记入「评审裁决」。
- **堆叠布局的收起**：≤1024px 时收起会让聊天页锁在一屏内（`.chat-page-solo`），对话列吃掉工具栏以下全部高度；原先按 50vh 留白会让 844×390 的发送按钮掉出视口，composer 用例当场抓住。
- **拖拽条**：初版只有一条 2px 的浅色线，截图里几乎看不见，改成中段加一小截抓手，悬停与拖动时变强调色。
- **提示进对话流，且不可关闭**（用户追加）：三处页面级 Alert 移进 `.messages-inner`；其中生成中断/失败/断流不再用可关闭的 Alert，改成对话里的一行记录（`⏹` 图标走伪元素，读屏不念），文案直接给原因：`你取消了这次生成`、`生成中断：<服务端原文>`、`请求失败：<原文>`、`生成连接中断，任务已取消`。删掉了 `dismissedTaskError`，正在跑的一轮不再显示上一轮的失败。
- **既有断言的改写**：`chat-parity` 的占位说明改为「默认收起、点开才见」；`chat-preview-rebuild` 的重建进度改为断言对话流里的提示，失败提示从 `.ant-alert-*` 改为 `.message-note`；`chat-composer` 的可关闭用例改成「不可关闭、轮询后与任务一致」。

验证：`type-check` 通过；单测 369/369；集成 232 过 / 1 跳过 / 0 失败；`verify.mjs` 跑 `chat-layout`（新增 10 条）、`chat-composer` 27、`chat-parity` 12、`chat-preview-rebuild` 12、`version-panel` 14、`platform` 5 全绿，证据在 `.pi/skills/verify-paimeng-agent/evidence/`。`home-parity` 仍是 5 条预存失败（登录跳转），与本次无关。
