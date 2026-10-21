# 应用版本化：git 裸库、主线迭代与可回退历史

用户要求：生成过程支持选择特定版本继续迭代、对不满意的结果回退。已确认的决策：

- 存储用 git 裸库，历史数据放在工作区之外，工作区本身不含 `.git`
- 主线线性只增：每轮生成成功自动记录一版；回退不销毁历史，而是在主线新增一版
- 分支是显式动作（多方案/从旧版重走），采纳后回收，不删提交
- Agent 拿到版本管理工具（发现 + 执行），因为用户会用「我喜欢那个蓝色卡片的版本」这类模糊描述；执行类操作可逆，所以不需要审批门禁
- 保留 UI 直点路径：用户知道是哪一版时点按钮最快

## 1. 回退是指针移动，不是新增一版

回退做三件事：物化工作区到目标版本、把当前版本指针指向它、把分支引用移回那个提交。**不新增版本记录**——否则用户每回退一次时间线就多一条凭空出现的记录，语义也不对。

被甩在当前历史线之外的版本不删除，标成 `superseded`（界面显示「已回退」，样式压淡），点它就能再跳回来。所以回退依然是可逆的：任何一次误回退，点回更新的那一版就恢复了。

版本序号在应用内全局递增、不复用，因为指针回退后按分支内计数会与已有版本撞号。

术语上元数据表里的 `restore` / `checkpoint` 两种 `kind` 现在分别是：一次真正带内容变化的回退记录（只在旧数据里出现）与「切版前把未提交改动留成快照」。

## 2. 目录与数据布局

```
runtime/
├── code_output/<codeGenType>_<appId>/       工作区（模型的操作现场，无 .git）
└── versionstore/
    ├── <codeGenType>_<appId>.git/           应用专属裸库（objects/refs，外面看不到）
    ├── versions/<appId>/<versionId>.png     版本缩略图（可选）
    └── .locks/<appId>.lock                  跨进程写锁
```

裸库只被平台使用；工作区的 `.git` 仍在 `workspace.ts` 的 `blocked` 集合里，模型与文件工具都碰不到版本数据。

`git` 调用统一走 `--git-dir=<repo> --work-tree=<workspace>`，封装在 `src/server/version-store.ts`。

## 3. 表结构（migrations/004_versioning.sql）

| 表 | 作用 | 关键列 |
| --- | --- | --- |
| `app_version` | 版本记录 | `id`、`app_id`、`branch`、`seq`（分支内递增）、`commit_sha`、`kind`（generate/restore/branch/adopt/checkpoint）、`source_version_id`、`title`、`prompt`、`changed_files`、`file_count`、`bytes`、`thumbnail_key`、`generation_id`、`create_time` |
| `app_version_state` | 每个应用一行 | `app_id`、`branch`（当前分支）、`head_version_id`、`version_seq`、`update_time` |
| `app_version_branch` | 分支登记 | `app_id`、`branch`、`base_version_id`、`status`（open/adopted/discarded）、`create_time` |

版本 `title` 由模型生成一句 **20 字以内的中文概述**（`src/server/version-summary.ts`），输入是当时的用户原话 + 改动文件清单，**不直接照抄用户原话**。生成收尾时先落兜底标题（「改动 N 个文件」、按 `kind` 的固定文案），随后异步替换成模型概述；模型失败就用兜底，绝不阻塞生成。

优先级：别名 `version.summary` → 没有则用 `codegen.default`。不用 `route.classify`：那是类型路由的专用模型，可能被限定用途或地区不可用（实测 beam-free 直接返回 "not available in your country"）。

历史版本可以用 `npm run versions:titles -- [--app <id>] [--apply]` 重算（默认预演）。

## 4. 版本引擎契约（`src/server/version-store.ts`）

| 函数 | 语义 |
| --- | --- |
| `commitVersion(app, input)` | `add -A -f` 后提交，工作区无变化则返回 `null`（不产生空版本）；成功写入 `app_version` 并推进 `app_version_state` |
| `materialize(app, sha)` | 让工作区**等于**该提交：`read-tree -u --reset` 清掉索引里多出的文件，再用 `clean -fd` 带排除项清掉未跟踪文件；不碰 `node_modules`/`dist` 等 blocked 目录；恢复后补齐 `assets/uploads`、`public/uploads` 空目录 |
| `restoreVersion(app, versionId, reason)` | 有脏改动先记 `checkpoint` → materialize 目标 → 分支引用与当前指针一起指回目标（**不新增版本**）；目标已经是当前时返回 `unchanged` |
| `listVersions` 的 `superseded` | 当前分支上、但已不在其历史线里的版本；标成「已回退」，仍可再跳回去 |
| `branchFromVersion(app, versionId, label)` | 以目标提交建分支，并把当前分支切过去 |
| `adoptBranch(app, branch)` | 把分支头内容物化到主线，提交 `adopt` 版本，分支标记 adopted |
| `switchBranch(app, branch)` | 物化目标分支头，不产生新版本 |
| `listVersions` / `getVersion` / `diffVersions` | 读路径：列表、单条详情、两版差异（`git diff --stat` + 文本补丁） |

写路径统一拿 `.locks/<appId>.lock`（O_EXCL 原子创建，超时重试，60 秒视为陈旧），因为 Next 与 harness 是两个进程，进程内 mutex 不够。**租约检查不在存储层**：版本工具跑在持有租约的那次生成里，它自己就是唯一写者；`versionBlockedReason` 只服务面板的 `blocked` 展示与 HTTP 入口的 409。

**精度工程（易踩坑，逐条实现）**：不能沿用工程自带 `.gitignore`（会漏掉 `dist`、上传素材），提交必须 `add -A -f`；`checkout <sha> -- .` 只恢复不删除，必须用 `read-tree -u --reset` 语义；`clean` 必须排除 `node_modules`/`dist`；空目录恢复后补齐；恢复前先给脏状态留快照。

## 5. 何时记录版本

`finishGeneration`（`generation-store.ts`）是唯一的终态闸口，但记录版本放在 `durable-engine.ts` 成功收尾之后调用，因为那里有应用、用户输入与生成 id 上下文。

- 只有 `status === 'ready'` 且工作区相对当前头有变化才记版
- 失败/取消不记版；它们的残留文件由下一次成功版本或手动回退覆盖
- 记录版本失败不能影响生成结果（`catch` 后落日志），版本是可加的旁路能力

## 6. Agent 工具（`harness-server.ts`）

| 工具 | 性质 | 说明 |
| --- | --- | --- |
| `listVersions({query?,limit?})` | 只读 | 返回 `versionId`、`title`、时间、`kind`、当前分支、改动文件摘要 |
| `getVersion({versionId})` | 只读 | 单条详情 + 改动文件列表 + 缩略图路径 |
| `restoreVersion({versionId,reason})` | 可逆写 | 恢复内容并新增一版 |
| `branchFromVersion({versionId,label})` | 可逆写 | 从某版开分支并切过去 |
| `adoptBranch({branch})` | 可逆写 | 采纳分支到主线 |

三条纪律写进工具描述与执行体：

1. 恢复/切版后平台注入「工作区已变更，编辑前请重新读取文件」，工具返回值里也带这条提醒，避免模型拿旧内容覆盖
2. 工具不检查租约：它就跑在持有租约的那次生成里，自己就是唯一写者；占用检查只在 HTTP 入口
3. 含糊指代靠多步推理解决：先 `listVersions` 筛候选，再用 `getVersion` 看标题、当时的输入与改动文件确认，最后才 `restoreVersion`

不提供：删除版本、重写历史、删除应用。

**能力边界（按当前工具协议）**：工具结果只有文本，模型拿不到图像输入，所以「那个蓝色的版本」这类纯视觉指代只能靠标题、当时输入与改动文件匹配，不能真去看缩略图。缩略图只服务产品界面的版本时间线。要让模型真正看图，需要工具结果支持图片内容块，属于后续项。

## 7. API（`src/app/api/app/versions/*`）

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `app/versions` | GET | 列表 + 当前分支/版本 |
| `app/versions/restore` | POST | 回到指定版本 |
| `app/versions/branch` | POST | 从指定版本开分支 |
| `app/versions/adopt` | POST | 采纳分支 |
| `app/versions/switch` | POST | 切换当前分支 |
| `app/versions/diff` | GET | 两版差异 |
| `app/versions/thumbnail` | GET | 版本缩略图 |

全部沿用现有鉴权与 `guardRequest` 约定；写操作在生成运行中返回 409（与部署按钮禁用一致）。

## 8. UI

版本历史是**树**，不是卡片列表：

- 左侧一条窄栏画整棵树（一张 SVG，几何由服务端算）：泳道竖线、跨泳道合并曲线、节点圆点（当前分支头实心、历史节点空心、被回退的节点半透明）
- 右侧每行是「缩略图 + 版本号/标签/时间 + 标题 + 操作」，没有卡片边框，只有行分隔线；行高固定，连线才能连续
- **泳道按 git 父子关系算，不按版本记录里的分支字段**：指针回退会让一条分支指向另一条分支的提交，按分支字段分泳道会画出假竖线
- 行序同样是拓扑序（子在上、父在下，同层按时间倒序），并且不依赖 `git rev-list --all`——回退后不被任何分支引用的提交仍是历史的一部分
- 顶部图例按分支去重，同一分支只出现一次；**节点与连线按「这条提交属于哪条分支」着色，不按泳道**——泳道只是排版，一条泳道会先后走过两条分支，按泳道上色会渲染出「两条分支三种颜色」
- 泳道数由拓扑决定（一个分叉点一个泳道），不等于分支数：两个提交都直接挂在同一个提交下时就是两条线

聊天页头部加「版本」入口，打开右侧面板（与既有抽屉风格一致）：

- 时间线倒序：该版本的页面截图、序号与标题、时间、改动文件数
- 单条操作：`对比`、`回到此版本`、`从此版开分支`；当前版本的「对比」「回到此版本」都禁用
- 被回退甩下的版本压淡并带「已回退」标签，操作仍可用（跳回去就是普通的回退）
- 顶部显示当前分支与当前版本；分支未采纳时显示「采纳到主线」「丢弃」
- 运行中（租约活跃）时写操作按钮禁用并提示原因
- 没有缩略图的版本显示占位（标题 + 改动文件），不假装有图

## 9. 分解与所有权

| 单元 | 负责人 / 工作区 | 独占写入范围 | 依赖 |
| --- | --- | --- | --- |
| U1 契约与计划 | 主代理 | 本计划、`src/shared/versioning.ts`、迁移 004、`schema.ts` | 无 |
| U2 版本引擎与记录 | 主代理 | `src/server/version-store.ts`、`durable-engine.ts` 收尾、`artifacts.ts` 缩略图 | U1 |
| U3 Agent 工具与 API | 主代理 | `harness-server.ts`、`src/app/api/app/versions/**` | U2 |
| U4 版本面板 UI | worker / 独立工作树 | `src/components/chat/version-panel.tsx`、`version-panel.css`、对应单元测试 | U1、U3 契约 |
| U5 集成与验收 | 主代理 | 集成修复、测试调度 | U2、U3、U4 |

## 10. 验收线（已实测）

- [x] 单元/集成：版本引擎对临时目录与临时裸库验证——提交→改动→恢复回到字节一致、多余文件被清掉、`node_modules`/`dist` 不被清、空目录补齐、无变化不产生空版本（`tests/integration/version-store.test.ts` 9 例）
- [x] 集成：`add -A -f` 覆盖被 `.gitignore` 排除的上传目录，同时不收录依赖与构建产物（同文件首例）
- [x] 集成：真实 Postgres + 真实 git——生成成功自动记版（`version-generation.test.ts`，faux harness 跑完整个生成流）；回退后内容字节一致
- [x] 集成：HTTP 层在活跃租约期间拒绝写操作并回报 409，面板能读到 `blocked` 原因（`version-api.test.ts`）
- [x] 集成：Agent 工具链路——`restoreVersion` 经真实 harness 工具注册执行，磁盘内容真的回到目标版本，并新增 `restore` 记录（`version-generation.test.ts` 第二例）
- [x] 集成：鉴权、非法入参、缩略图缺失返回 404
- [x] E2E：版本面板时间线/空态/回退二次确认/占用时禁用/对比/失败重试（`tests/e2e/version-panel.spec.ts` 6 例）
- [x] `npm run type-check`、`npm run check:fast`、单元 350/350、`chat-composer` 27/27、dev 告警门禁 2/2

### 实测中发现并修掉的两个真问题

1. **租约拦截把 Agent 自己的回退挡住了**：存储层的 `restoreVersion` 原本检查「应用正在生成」，而版本工具正是运行在那次生成里、本身持有租约。改为把租约策略放在 HTTP 入口（`assertVersionWritable`），存储层只做读写；面板能否点由 `blocked` 字段决定。
2. **删除应用时版本历史漏回收**：原写法在应用已软删之后再 `getApp` 取 `codeGenType`，必然 404 被 `catch` 吞掉。改为删除前先取快照。

### 环境相关的既有失败（与本次改动无关）

`tests/system/build.test.ts`、`tests/system/template-build.test.ts` 的真实 Docker 构建用例在本机超时。用 `git stash` 在干净基线上复跑，失败完全相同，确认是环境/负载问题，不是版本化改动引入的。

## 11. 版本截图

每个版本都要能看出「它长什么样」。工作区里永远只有当前版本，所以截图不能靠当前预览，而是**从提交内容离屏还原**：

1. `git ls-tree` 列出该提交的文件，逐个 `git show` 写入临时目录（不动主工作区的 index）
2. Playwright 用 `file://` 打开临时目录里的 `index.html`，外链一律断掉，避免截图受当前网络影响
3. 截图存 `runtime/versionstore/versions/<codeGenType>_<appId>/<versionId>.png`
4. 生成收尾时顺手截一张；面板打开时若还没有就现截（按版本 id 去重，全局串行，避免并发拉起多个 Chromium）

限制：只支持静态页面（`html` / `multi_file`）。`vue_project` / `react_project` 的提交里没有 `dist/`，要截图就得先构建；这类版本暂时显示占位，不复用「当前预览」蒙混过去。

## 12. 上线步骤（顺序不能反）

1. `npm run db:migrate` —— **代码先上、迁移没跑**时版本表不存在，面板会报「服务处理失败」，而生成收尾的记版失败只出现在服务端日志里，用户看到的就是「生成完成了但版本里没有」。
2. 重启常驻 harness（`npm run durable:harness`）—— 版本工具是协议 7 的一部分。
3. 存量应用补记基线：`npm run versions:backfill` 先预演，确认后 `npm run versions:backfill -- --apply`。版本化之前生成的应用工作区有源码但没有版本记录，补记后才有可回退的起点。

## 13. 已知限制（明确不做）

- 工程类型（vue/react）的版本没有截图：需要重新构建才能渲染，暂不做
- 版本描述不调用模型生成，靠用户输入原文 + 改动文件检索；模型看不到缩略图（工具结果只有文本），纯视觉指代可能定位不到
- 不清理旧版本、不做孤儿对象 GC；`16MB`/`256` 文件上限下存储成本可忽略
- 回退不重放 harness 转录：文件回到旧版，对话历史保留，靠注入事件让模型重新读取
- 不做跨应用版本复制
