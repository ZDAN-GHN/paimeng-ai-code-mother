# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

现有代码库是 `paimeng-ai-code-agent/` 下的 Next.js + React + TypeScript 应用；界面原型是 `docs/prototypes/` 下的静态 HTML/CSS/JS，不进入生产构建。原型按生命周期分三档：`docs/prototypes/in-progress/`（正在推进实现）、`docs/prototypes/deprecated/`（生成过但不采纳）、`docs/prototypes/archive/`（实现后归档），生命周期规则见 `docs/AGENTS.md`。旧 Vue/Java 实现位于仓库根的 `archive/`（与 `docs/prototypes/archive/` 是两回事），只作为迁移参考，不是当前产品事实。

## Users

主要用户是**没有编程能力、但有明确网站或应用想法的人**：独立经营者、小团队创始人、设计师、内容创作者和运营人员。他们在浏览器里用中文描述想要的东西，希望先看到一个能点击的版本，再通过对话修改，最后拿到一个可以公开访问的网址。次要用户是 Owner 之外的管理员（Admin），负责用户、应用和模型配置，但不代替 Owner 生成、取消、部署或下载应用。

## Product Purpose

把一句自然语言描述，变成一个可用、可预览、可修改、可发布的网站或应用。产品的成功不是“生成了一段代码”，而是用户在不写代码的情况下得到第一版、看懂它、改到满意，并把它发布出去。

## Positioning

派蒙不是一次性把提示词变成代码的玩具，而是一间有工序的应用工坊：每次生成都有真实的构建与校验、可回看的版本、可操作的实时预览，以及可撤销的修改。用户拥有自己的应用和版本历史；对话是持续的工作往来，不是一次性的抽卡。

## Operating Context

- 首页：描述需求、选择技术栈或从模板起步、浏览自己的应用与精选案例。
- App chat：围绕一个 App 的连续对话，跨越多次 Generation；显示生成状态、工具进展、预览与源码、版本历史和部署入口。
- 生成状态：generating（生成中）、building（构建中）、ready（可预览）、failed（失败）、cancelled（已取消）。Generation 是一次完整请求，结束后不复用；新的输入产生新的 Generation。
- 产物类型：HTML、多文件静态站、Vue 工程、React 工程；模板有版本，产物类型没有。
- 用户可以在生成中 Steer（在步骤边界插入输入），也可以在结束后 Follow-up（开启下一轮）；Harness 可以提出 Question，当前 Generation 暂停等待回答。
- 发布后得到可访问的网址；App、版本和部署都归 Owner 所有。
- 当前产品是中文优先的 Web 产品；桌面是主要工作环境，移动端需要能查看预览、继续对话和发布。
- 这是面向非技术用户的工具：术语必须让位于结果，按钮要说明动作，错误要说明原因和恢复方式。

## Capabilities and Constraints

- 已确认能力：自然语言生成、生成状态与工具进展、实时预览、源码查看、版本历史与恢复、部署、图片/语音输入、模型与模板管理、登录与管理员后台。
- 生成由 pi-durable harness 承载；Next.js 负责鉴权与 SSE 转发，不负责生成本身。
- 版本、部署和取消是 Owner 的私有操作；管理员可以编辑或删除 App，但不能代替 Owner 执行这些操作。
- 真实模型调用、真实数据库和生产部署不在界面原型范围内；原型只能演示状态与交互。
- 不得虚构真实客户、用户量、性能数字、价格、合作方或可访问的生产网址。演示数据必须标注为演示。
- 不引入未经确认的付费能力、服务承诺或数据留存承诺。

## Brand Commitments

- 产品名：**派蒙 AI 应用工坊**；英文可用 **Paimeng Application Workshop**。
- 中文优先，语气直接、克制、具体；不喊口号，不堆“颠覆”“赋能”“一键起飞”这类词。
- 用户明确要求：网站必须有**属于自己的艺术美感**，要**优雅**，要**质朴的酷**；不能是通用 AI SaaS 的默认样子，也不能靠模仿 v0、pi.dev 或其他产品的视觉语言来成立。
- 旧的 `docs/prototypes/deprecated/v0-pi/` 是历史尝试，不是品牌基准；新一轮工作可以完全替换它的视觉世界。
- **界面语言（Owner 指定，2026-10-30）：** 采用“工具界面”——布局与交互密度参照成熟的桌面工具应用（Owner 点名 claude desktop 的布局语法）。身份由材料（苔石灰中性色阶 + 单一黄铜强调色）、小字号节奏与发丝线承担，不靠主题世界（羊皮纸、胶片、施工图）或角色形象成立。
- **明暗双主题是硬要求：** 两套都是独立调过的值，不是反相；任何新界面必须在两套下分别成立。
- **标记可替换：** 产品标记是一个分段方块图形（四段不等），不绑定派蒙角色；图标与名称都允许替换而不影响识别。
- 品牌需要能离开界面独立存在：一个可识别的标记、一套可复用的版式与材料语言，而不是只在首页成立的装饰。

## Evidence on Hand

- `GLOSSARY.md`：App、App chat、Owner、Admin、Generation、Generation status、Generation phase、Generation type、Template、Input、Steer、Follow-up、Question、Candidate、Execution、Attempt 等术语的权威定义。
- `paimeng-ai-code-agent/src/app/page.tsx`、`src/app/app/chat/[id]/page.tsx`、`src/components/chat/*`：现有首页、对话、预览、版本、部署和生成反馈的实现。
- `paimeng-ai-code-agent/docs/`：产品、数据模型、运行与迁移文档。
- `paimeng-ai-code-agent/public/paimeng.png` 是现有的派蒙同人角色图；它来自外部作品，不能作为新品牌的视觉基础。
- `docs/prototypes/in-progress/workbench/`：当前方向的界面原型（首页 / 工作台 / 移动端，明暗双主题）。
- **没有**可直接引用的真实精选案例、客户证言、用户数量、性能基准或生产部署 URL。原型中的 App 名称、委托方、日期、版本号和网址均为演示数据。

## Product Principles

1. **先做出来，再改准确。** 第一版的价值是让用户看见和点击，而不是一次猜中。
2. **每一版都能回去。** 版本、预览和发布状态必须可追溯、可恢复。
3. **展示真的东西。** 用可操作的预览、真实的构建状态和源码说话，不用概念图代替结果。
4. **用户拥有自己的东西。** 应用、版本和部署属于 Owner；管理员权限不能越过这条边界。
5. **说人话。** 面向非技术用户，少用平台术语；每个动作都说明会发生什么。

## Accessibility & Inclusion

目标是 WCAG 2.2 AA：正文对比度至少 4.5:1，键盘可完成主要流程，焦点可见，尊重 `prefers-reduced-motion`，移动端可读可点。产品面向中文用户，不依赖英文缩写理解核心操作。

## Assumptions

本文件根据仓库文档、现有实现和用户本轮的原话整理，未进行单独的产品访谈。以下为推断，需 Owner 确认：

- 主要用户是非技术创作者与小型经营者，而非专业开发者。
- 首页的核心动作是“描述需求并生成”，模板是辅助起点而不是主路径。
- 现有产品已经具备版本恢复、部署和管理员后台；原型可以演示这些能力，但不连接真实服务。
- “优雅、质朴的酷、自己的艺术美感”是品牌承诺，不是一次性的页面风格。
