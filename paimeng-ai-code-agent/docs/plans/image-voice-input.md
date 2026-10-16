# 图片输入与语音输入（参考 ChatGPT 输入框）

状态：U1–U4 已实现并合并（808c35c / ead77e0 / aafaa9d / 86d9a4a），U5 集成与验证见文末「验证结果」。日期：2026-10-16。前一版更重的方案（附件用途/版本检查点绑定/回收站/记忆预算，
`docs/plans/image-input.md`，2026-10-15 放弃）只作为参考：它的校验与限值、multipart 解析、权限模型可复用，
但它把「附件生命周期 + 版本 + 记忆」捆在一起，范围过大，本方案不再包含。

## 目标与交付边界

用户在聊天输入框里能：附图（选择文件 / 粘贴 / 拖放）、看到缩略图并删除、随消息发送；图片作为**模型能看的内容**
参与本轮生成；消息里能看到自己发的图并可点击放大。语音：按住麦克风说话，转写成文字填进输入框（不自动发送）。

v1 明确不做：图片用途选择（素材/参考）、裁剪标注、附件回收站与定时清理、版本/检查点绑定、图片 token 精确计费、
纯图片无文字提交。这些在「已知取舍」里逐条写了理由。

## 契约（已冻结，`src/shared/attachments.ts`）

- 消息里的图片是**我们自己的 part**：`{ type: 'attachment', attachmentId, mediaType, filename }`。
  不存 base64、不存临时 URL——历史消息长期留在库里，图片字节有自己的存储与鉴权通路。
- 服务端在送模型前把它解析成 SDK 的 file part（`data` 为真实字节），历史轮次的图片不重复发送，只留一行文字占位。
- 上传接口返回 `AttachmentInfo`（id/原文件名/mediaType/字节/宽高），不含对象路径。
- 限值：单张 ≤ 5 MiB、单条消息 ≤ 4 张且合计 ≤ 12 MiB、解码后 ≤ 2000 万像素、送模型前最长边 ≤ 2048px。
- 白名单：JPEG / PNG / WebP（静态）。SVG、GIF、HEIC 明确拒绝并给出可操作提示。

### 服务端接口（U1 与 U2/U3/U4 之间的边界）

| 接口 | 形态 | 说明 |
| --- | --- | --- |
| `POST app/attachment/upload` | multipart，文本字段 `appId` + 文件字段 `images`（可重复，顺序即返回顺序） | 需要登录且为应用创建者（`getApp(appId, user, true)`，管理员不例外）；响应走 `success()` 包装：`{ code, data: { attachments: AttachmentInfo[] }, message }`；单请求缓冲上限 13 MiB，超限 413 |
| `GET app/attachment?appId=&id=` | 二进制（不走 `success()` 包装） | 仅创建者；`content-type` 为真实类型，`private, max-age=300`；非本人 403、不存在 404 |
| `POST app/chat/transcribe` | multipart，字段 `audio` | 需要登录；返回 `{ text }`；未配置语音别名时 409/40000「未配置语音转写模型」 |

服务端模块边界（U1 提供、U2/U4 消费）：

- `createImageAttachment({ userId, appId, originalName, data, signal })` → `AttachmentRow`
- `readAttachmentBytes({ attachmentId, userId, appId })` → `{ bytes, mediaType, filename }`（严格校验 `ownerUserId === userId` 且附件 appId 匹配；鉴权失败抛 403/404。不放宽给管理员——管理端看的是历史文本，不展示这些图片）
- `attachmentViewUrl(appId, attachmentId)`（客户端拼 URL 用，服务端不返回临时链接）

## 单元

| ID | 交付 | 负责人 | 输入 | 写边界 | 依赖 | 验收 |
| --- | --- | --- | --- | --- | --- | --- |
| U1 | 附件存储 + 上传/读取接口 | 子代理（worktree `img-server`） | 本契约 | `migrations/012_attachments.sql`、`src/server/{schema,attachment-store,image-files,image-upload}.ts`、`src/app/api/[...path]/route.ts` | 契约 | 真实 multipart 上传 → 库行 + 对象落盘；越权 403；超限 413；非白名单 400；`sharp` 校验像素/EXIF/派生图；集成用例 |
| U2 | 多模态输入 + 能力校验 + 工作区素材副本 | 子代理（worktree `img-agent`） | 契约 + U1 模块边界 | `src/server/agent.ts`、`src/shared/model-config.ts`、`src/server/models/admin.ts`、`src/app/admin/modelManage/page.tsx`、`src/server/generation-instructions.ts` | 契约 | 图片 part 进模型（fixture 模型断言收到 file part）；别名未声明 `imageInput` 时明确拒绝；历史图片不重复发送；素材副本进 `assets/uploads/`；集成用例 |
| U3 | 输入框附图与消息展示 | 子代理（worktree `img-client`） | 契约 + 接口表 | `src/app/app/chat/[id]/page.tsx`、`src/components/chat/image-attachments.tsx`（新）、`src/components/clipboard-images.ts`（新） | 契约 | 选择/粘贴/拖放、缩略图与删除、上传失败可重试、发送后消息内可见可放大、刷新后历史仍显示；纯函数单测 + E2E |
| U4 | 语音输入 | 子代理（worktree `img-voice`，U1 之后） | 契约 + 接口表 | `src/server/speech.ts`（新）、`src/app/api/[...path]/route.ts`、`src/app/app/chat/[id]/page.tsx` | U1（同文件 route.ts） | MediaRecorder 录音 → 转写 → 文本进输入框；未配置别名时明确提示；录音上限与取消；集成用例 + E2E |
| U5 | 整合、文档、验证 | 主代理 | 全部 | `docs/plans/image-voice-input.md`、`README.md`、`docs/implementation-contract.md` | U1–U4 | tsc/check:ui/check:e2e/verify:boundary、`npm test`、`test:e2e:dev`、`test:e2e:isolated`，真机手测 |

共享资源：U1 与 U4 都改 `route.ts`，所以 U4 排在 U1 之后；其余单元文件不重叠。子代理只跑 tsc 与自己文件的
vitest，不跑 E2E（E2E 由主代理串行跑，避免抢测试库与端口）。

- **客户端消息里的图片放在 metadata，发送时才合并进 parts**（U3 定案）：`parts` 保持 SDK 合法的联合类型，避免 `useChat` 内部与流式归约遇到未知 part；`DefaultChatTransport.prepareSendMessagesRequest` 在发送时把 metadata 里的附件合并进最后一条消息的 `parts`，形状严格等于契约的 `{ type:'attachment', attachmentId, mediaType, filename }`。展示只有一条路径（本地从 metadata、历史从 parts，同一组件、同一 zod 校验）。排队消息自动发送走同一条合并路径。
- **队列函数改为泛型**（`enqueue/dequeue/removeQueued` 约束 `{ text: string }`）：字符串元素行为逐字不变，排队消息可带附件。

## 已知取舍

- **不做用途选择**：早期方案的「素材/参考」单选要求用户先理解一个额外概念。v1 把上传图片一律复制到
  `assets/uploads/`，并在生成指令里写明「只有用户明确要求用作素材时才在页面引用它；用于理解布局/样式的参考图
  不要写进网站」。用户文字里的意图已经足够表达，减少一个必填控件。
- **模型视觉能力**：别名能力新增 `imageInput`（默认 false，需在模型管理里勾选）。不声明就发图片时直接拒绝并说明，
  而不是把 provider 的原始报错丢给用户。声明为 true 但上游不支持时，按模型错误处理（记 `model-error`）。
- **不重复发送历史图片**：图片只在被发送的那一轮进模型，历史轮次替换成 `[图片：文件名]` 占位。避免每轮重复上传
  数 MB base64 与随之而来的费用，代价是模型看不到早前轮次的图（可让用户重新发送）。
- **语音依赖外部转写服务**：项目现有 provider 没有音频接口，所以语音走「可配置的 OpenAI 兼容
  `/audio/transcriptions`」别名 `speech.transcribe`；未配置时麦克风按钮禁用并提示，而不是假装可用。
- **不做附件回收**：上传后未发送的图片会留在库里与磁盘上。已知会积累垃圾数据，等真实使用后再按引用关系做清理
  （早期方案里那套「草稿过期 + 引用计数 + 清理器」现在没有证据支撑其复杂度）。
- **发送失败会清空草稿**：上传成功的图片在发送前就从输入区移除，发送失败时只给一句「图片未随消息发出，请重新添加」
  （不自动恢复草稿）。保留草稿要区分「已发送成功」与「发送失败」两条路径，v1 选了简单的一边。
- **转写没有限流**：聊天生成有限流，转写接口目前只有登录与 10 MiB 体积限制，没有按用户限流；真实开放前需要补。

## 验证结果（U5 集成后实测）

| 检查 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 干净 |
| `npm test` | 67 文件 / 560 例全过 |
| `npm run check:ui` / `check:e2e` / `verify:boundary` / `git diff --check` | 通过 |
| `npm run test:e2e:dev` | 2 通过（无 antd/React 告警） |
| `npm run test:e2e:isolated`（3020/3021） | 79 通过 / 2 跳过 |

新增 E2E：`tests/e2e/chat-images.spec.ts`（真实 multipart 上传 → 断言发出去的 parts 是契约四字段 →
消息里显示缩略图并可放大；非图片文件被客户端拒绝）、`tests/e2e/chat-voice.spec.ts`（桩替换
`getUserMedia`/`MediaRecorder`：录音 → 转写 → 文本进输入框不自动发送；未配置转写时按钮禁用并说明原因）。
集成时修了两处子单元各自的盲区：语音集成用例缺 `imageInput` 字段（两个单元各自跑 tsc 时发现不了），
以及输入区多出两个按钮后短窗口/手机上发送按钮被挤出视口（`chat-composer.spec.ts` 的视口用例抓到，
已把键盘提示在 ≤600px 隐藏、不能附图的原因单独成行）。

**未验证**：真实视觉模型的多模态端到端（fixture 与集成用例停在模型边界）、真实麦克风与真实转写服务
（E2E 用桩）、Firefox 真机上的录音（`MediaRecorder` 实现差异）。
