# 运行中的聊天、原生输入队列与断连恢复

用户已授权实现：运行时禁用部署，空输入发送键切为取消；插话和排队分别展示，输入真正进入 pi 上下文后才成为气泡；修复阶段构建卡片卡住。

基线为 `75c7764` 加当前未提交改动（插话分段、联网结果 details、取消联网累计额度）；保留这些改动。基线补丁位于 `/tmp/chat-runtime-baseline.patch`，UI 隔离工作树快照 `c324c09`。只交付本地改动，不发布或部署。

## 分解与所有权

这是多接口任务：服务端接收/队列状态、前端交互、连接恢复可以独立验证。先固定 U1 契约，U2 与 U3 并行，U4 在两者交付后集成。

| 单元 | 负责人 / 工作区 | 独占写入范围 | 依赖 | 状态 / 下一验收 |
| --- | --- | --- | --- | --- |
| U1 共享契约 | 主代理 / 当前工作区 | `src/shared/chat-runtime.ts`、本计划 | 无 | 已完成，最终类型检查通过 |
| U2 原生队列与运行恢复 | 主代理 / 当前工作区 | `src/server/durable-engine.ts`、`src/server/durable/harness-server.ts`、`src/server/generation-store.ts`、`src/server/agent.ts`、API 路由、协议版本、集成测试 | U1 | 已完成；整套集成 26 文件 / 155 例通过，审查问题已解决 |
| U3 输入区与状态恢复 | worker / `../.pi-worktrees/chat-runtime-ui` | 聊天 `page.tsx`、`chat.css`、`src/components/chat/generation-feedback.ts`、`chat-inputs.ts`、对应单元测试与 `tests/e2e/chat-composer.spec.ts` | U1 | 已交付并集成；暂态审查 P1/P0 均关闭，主代理补齐横屏与重发草稿修复 |
| U4 集成与验收 | 主代理 / 当前工作区 | U2/U3 完成后的集成修复 | U2、U3 | 已完成，所有适用验收通过；改动仍未提交 |

独立只读 scout 查真实运行的构建卡片与后台状态，不修改会话或源码；UI 完成后 fresh reviewer 审查该组件边界。主代理承接审查、集成和最终验收。禁止多个写入者共享 cwd。集成测试与浏览器运行由主代理串行调度以隔离数据库、端口、构建缓存。

## U1 契约

`src/shared/chat-runtime.ts` 为共同输入：

- `POST app/chat/input`：`{appId,id,mode:'steer'|'followUp',text,attachments}`，id 由客户端预先创建，便于接收事件先于接口返回时匹配。返回 `ChatInputReceipt {id,submissionId,generationId,state:'queued'|'placed'}`。只在产品任务活跃时接受；空闲前端走原有流式生成入口。
- `GET app/chat/runtime?appId=`：`ChatRuntime {generation,busy,pending,messages}`，generation 是产品任务态，busy 是 pi 运行态；pending 是 pi.inbox 的原生队列，messages 是权威转录和可展示的进行中状态。权限同对话。
- `POST app/chat/input/cancel`：`{appId,submissionId}`，撤回未接收输入，返回 `{state:'aborted'|'already_placed'|'settled'}`。
- 既有 `data-steer {id,index}` 同时用于这两类输入的接收边界；`index` 为流式助手已产出 part 数。`app/chat/steer` 保持兼容。
- 已接收消息不作为普通用户消息插到 `useChat.messages` 末尾；按边界渲染或等 SDK 流退出再使用权威快照替换。
- 前端轮询兜底：运行中断连/刷新后，从 runtime 恢复历史和原生队列；后台确认终态且属于当前请求时停止失效的本地流、拉取权威历史，避免工具卡片保持进行中。

## U2 验收

- pi.inbox 区分 steer/followUp，阻塞时只在队列；已 placed 直接显示气泡。
- followUp 导致 pi 切换到下一 run 时不能提前终止观察或过早最终构建。
- 取消可到达生成和最终构建；取消后输入队列回收状态明确。
- Next 观察者消失、harness 运行结束、过期租约等真实状态有明确恢复或终态，不能因心跳永远续租而僵住。
- harness 在线形状改变，协议 5 升为 6。
- 通过相关真实 harness/数据库集成用例。性能：沿用 1.5s 状态轮询，不设置静默超时为任务终态；未改模型调用步数和时长限制。

## U3 验收

- 任务运行（含刷新后只有任务态）禁用部署；空文本时按钮是“取消”，有文本时按钮是“发送”并走 followUp；Ctrl+Enter 是 steer。
- 输入框上方独立展示“插话队列”和“排队消息”；没有 queued 状态就没有队列闪烁；接收后离开队列，出现正确位置的气泡，接口和事件乱序不丢消息。
- 删除队列项真实撤回 pi 输入；附件随 followUp 保留，插话仍仅文字。
- 断流/刷新恢复时更新正在运行的工具卡片；终态不留 spinner。
- 844×390、375px 等视口，输入、主按钮不被队列撑出面板；提示常显、键盘与组合输入正常。

## U4 集成与证据

- [x] 读取两条交付的实际 diff，处理审查中的实证问题。
- [x] `npm run type-check`、`npm run check:fast`、34 文件 / 336 个单元测试。
- [x] 真实 harness 原生队列/恢复/取消等 26 文件 / 155 个集成测试。
- [x] 聊天浏览器共 26 项：首轮 25 项中的横屏队列零高度与连续文本断言修复后，受影响 6 项重跑全过；追加失败保留原生 inbox 分支及相关 8 项回归全过。最后一次 `npm run test:e2e:dev` 2/2 通过。
- [x] 检查最终 diff 与用户现有改动，保留原有未提交改动；未发布、部署或提交。

性能验证不单独设基准：本任务没有性能目标或性能改善声明；运行状态与原生队列沿用 1.5 秒轮询，浏览器用例验证了活跃流不被轮询覆盖，不引入静默时长终止条件。

## 当前证据与交付检查

- 只读诊断确认真实会话 854 / Vue 博客任务 `cf1fe46d-457a-4348-a249-9d98a63cb844` 已 ready，无活动任务或租约；构建调用条目 1365 对应成功结果 1367。截图现象是前端结果没有补齐，不是当前仍有构建在运行。
- 最终后端验收为 26 文件 / 155 例通过：`/tmp/chat-runtime-acceptance-integration.log`。新增覆盖原生双队列、撤回权限、连续 followUp run、过期/缺失租约接管、补记模型记账缺口、生成/构建取消、成功与失败收尾守卫、503 重试成功、模型失败收尾前接受新输入继续观察。最后一个精确时序用例通过真实 HTTP bridge 和应用行锁制造提交先于收尾的顺序。
- 最终类型、静态、单元验证：`/tmp/chat-runtime-final-types.log`、`/tmp/chat-runtime-final-static.log`、`/tmp/chat-runtime-final-unit.log`；单元 34 文件 / 336 例。`git diff --check` 通过。
- 首轮 UI writer 因 `Connection error` 终止；保留 c324c09 隔离工作树及部分补丁后同协议恢复。最终交付 `/tmp/chat-runtime-ui.patch` 已合入主工作区；主代理负责进一步集成修复。审查提出的队列状态回退、重复气泡、恢复区文字附件丢失、旧历史覆盖新轮、历史失败无重试，以及迟到终态回执和重发清空新草稿等 P0/P1 均已关闭。最后一个 P2（重发时清除新草稿选中元素）通过保持 keepDraft 路径的编辑状态一并修正。
- 原主开发服务为协议 4；确认无活动任务后，已通过现有 supervisor 正常停止并重启。现 `/health` 协议为 6，进程日志 `/tmp/chat-runtime-dev.log`。未修改生产会话或生成记录；集成和浏览器测试使用独立测试库。
- 浏览器证据：`/tmp/chat-runtime-e2e-final.log` 首轮 23/25；修复横屏压缩与不正确的 exact 文本断言后，`/tmp/chat-runtime-e2e-recheck.log` 6/6 通过，覆盖原先失败项与受影响的小窗口、文字/附件重发。最后语义核对追加了失败时保留真实 pi inbox：仍排队的输入不进待重发区，继续轮询并可撤回，避免重复提交；历史与 pending 来自同一运行快照。`/tmp/chat-runtime-inbox-failure.log` 对该新增场景及迟到回执、失败提示、终态和断流共 8 项回归全过。
- 最后一次 dev 告警门禁 `/tmp/chat-runtime-dev-warnings-final.log` 为 2/2 通过。隔离检查的默认 Turbopack 曾持续触发整页重载；`scripts/test-e2e.ts` 改用与主开发服务相同的 `next dev --webpack` 后，聊天和原本失败的管理端告警检查都通过。最终主要源码哈希 `/tmp/chat-runtime-final-files.sha256`。
- 独立审查最终结论 OK with notes；所有 P0/P1 已解决，P2 的上下文清理也由主代理修复。没有仍阻塞本次交付的发现或验证缺口。
