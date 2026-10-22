# 对话生成与运行中输入

用户在一个应用里说需求，模型生成或修改源码，界面把过程以「条目流」实时展示：助手文字、工具调用卡片、思考折叠、预览刷新。运行中还能继续输入——`Enter` 排队（followUp）、`Ctrl/⌘+Enter` 插话（steer）。

## Sub-features

- 发送一条需求，看到流式助手回复与工具卡片（读取/写入/构建/联网搜索/图片素材）。
- 运行中空输入框时「发送」变「取消」，有内容时可发送。
- 插话（steer）与排队（followUp）各自成队，显示在输入框上方；被 pi 接收后才进入对话流。
- 撤回尚未被接收的排队/插话；未接收内容在失败后回到输入区，不丢草稿与附件。
- 图片上传（`attachment`）与语音转写（`speech.transcribe` 别名）。
- 生成过程中的预览自动刷新；断流/刷新后从权威转录恢复（不重复、不错位）。
- 历史消息渲染：Markdown、代码高亮、表格、XSS 转义、工具卡片结果。

## How to get to it (user POV)

1. 首页点「创建应用」，或在 `/app/chat/<appId>` 直达。
2. 首次进入输入框预填用户创建时的 `initPrompt`。
3. 输入需求回车发送，等待生成；运行中再次输入即可看到队列区。
4. 生成完成后右侧预览 iframe 更新，版本面板出现新版本。

## Driving it with Playwright

```bash
node .agents/skills/verify-paimeng-agent/helpers/verify.mjs tests/e2e/chat-composer.spec.ts
node .agents/skills/verify-paimeng-agent/helpers/verify.mjs tests/e2e/chat-parity.spec.ts
```

- 稳定句柄：输入框 `getByLabel('对话消息')`、发送按钮 `getByRole('button', { name: /^发\s*送$/ })`、消息流 `getByLabel('对话消息')` 所在面板、预览 iframe 用 `iframe` + `src` 含 `pv=`。
- 登录与建应用见 `chat-composer.spec.ts` 的 `beforeEach`：`/api/user/register` → `/api/user/login` → `/api/app/add`。
- 只验证输入框行为时，用 `page.route('**/api/app/chat/runtime?*')` 返回空闲投影、`**/api/app/generation?*` 返回 `cancelled`，避免被真实生成干扰（`chat-composer.spec.ts` 顶部有现成常量）。
- 需要流式内容可控时，spec 里用 `createUIMessageStream` 起本地 HTTP 服务并让应用指向它（同文件里有范例）。

## Gotchas

- 运行中输入有两个通道，快捷键不同：`Enter` 是排队、`Ctrl/⌘+Enter` 是插话。写断言时别混。
- 插话落点由服务端 `data-steer {id, index}` 决定（index = 当时已产出的 part 数），不是「插在末尾」。断言位置要按工具条目与文字段判断。
- 模型层在隔离实例里是 fixture（`AI_MODE=fixture`、`DURABLE_FAUX_*`），所以回复内容是脚本化的；这层替换是产品本来就有的边界，可以接受。界面行为本身必须走真实渲染。
- 语音需要 `speech.transcribe` 别名，未配置时麦克风按钮是禁用的——这是预期，不是缺陷。
- dev 构建的 React/antd 告警只在 `--dev` 模式出现，见 `home-and-auth.md`。
