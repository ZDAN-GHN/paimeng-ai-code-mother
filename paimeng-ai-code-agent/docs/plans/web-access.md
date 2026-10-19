# 联网搜索、网页读取与图片素材方案

状态：**U1–U3 已实施并验证；U4 部分完成**（2026-10-15）。实施记录与证据见文末「实施记录」一节；未完成项已明确列出。

修订：首版曾写「Tavily 需要 API key」，实测不准确。Tavily 有免密钥模式，无账号、无 key 即可调用，响应 schema 与带 key 完全相同；注册后另有每月 1000 credits 免费额度。首版曾把 Openverse 当图片主来源，实测它只索引开放许可素材，覆盖不了动漫角色类查询，现改为「许可可核验」的辅助来源，主来源改为 Tavily 图片结果。

修订（2026-10-19）：**取消我们自设的调用额度**（每轮搜索 3 次 / 读正文 3 次 / 搜图 2 次 / 导入 4 次、每轮联网输出 16000 字符、每轮图片累计 8 MiB）。只保留单次请求的字节、时长与返回量上限，以及工程自身的总大小/文件数配额；检索几次、导几张图由模型自己决定，真实配额由上游服务商与工作区把控。

基线：`main@91784f814264ae56fc429d7c39256e3268a40610`，调研开始时工作区干净。调研日期为 2026-10-15。实施仅修改 `paimeng-ai-code-agent/`，旧 Java/Vue、开发库、运行数据保持只读。

## 1. 建议

在现有 AI SDK `ToolLoopAgent` 内增加四个工具：`webSearch`、`readWebPage`、`searchImages`、`importImage`。

首版采用 **Tavily 免密钥 Search + Extract + 服务端受限图片下载**，图片候选默认取自 Tavily 的 `include_images` 结果；Openverse 作为「许可可核验」的辅助来源。Jina Reader 是管理员可选的正文读取回退。现有模型负责决定何时调用工具、理解正文和选择素材，不增加研究 Agent、重排模型或搜索摘要模型。

默认路径不需要任何 API key：Tavily 免密钥模式无账号、无 key、响应 schema 与带 key 一致，部署者日后注册免费 key 只是提高限额，代码无需改动。免密钥是共享限额且更慢，必须按第 3 节的限额与超时设计，不能把它当成无限量服务。

首版不增加数据库表、后台队列、浏览器服务、通用 MCP 网关、向量库或联网管理后台。配置先使用现有 `getConfig()` 与部署环境变量。按能力注册工具：免密钥时文本与图片工具都可启用，配置 key 只是提高限额。

## 2. 调研结果

### pi-web-access

检查了本机安装的 `pi-web-access@0.40.0`，仓库为 [nicobailon/pi-web-access](https://github.com/nicobailon/pi-web-access)，MIT。读取了 `README.md`、`exa.ts`、`extract.ts`、`storage.ts`、`ssrf-protection.ts` 和工具核心的相关部分。

它提供的是通用联网工具系统：

- 搜索服务商返回统一的来源结果，支持显式选择、顺序回退和多服务商聚合。
- Exa 配 key 时调用 REST API，无 key 时调用远程 MCP；免费 MCP 响应需要额外解析。
- 网页优先直接 HTTP 获取，提取 HTML 时使用 Readability、linkedom、Turndown，并有 Defuddle 等补充路径。遇到失败可按配置使用远端提取服务。
- 完整结果另存，模型先收到有限长度内容，再按需分页读取。
- 抓取层处理超时、响应大小、重定向、SSRF、代理与 fake-IP 特例。
- 图片 URL 可以作为视觉输入返回，但未提供本项目所需的“可复用素材检索 → 写入生成工程 → 跟随构建发布”完整闭环。

借鉴统一结果、明确失败、内容预算、来源保留与受控回退。首版不直接依赖整个扩展，也不搬入其几十种服务商、Pi 登录态、视频、GitHub clone、浏览器 cookie 和 curator 等能力。虽然它也提供独立 MCP 模式，接入它仍会增加一个本项目当前不需要的运行与协议边界。

### 其他开源项目

| 项目与检查位置 | 实际做法 | 本项目采用的部分 |
| --- | --- | --- |
| [Open WebUI：统一 SearchResult](https://github.com/open-webui/open-webui/blob/6a18585ff4c2e5f6805f682222cfbc46dc669ef8/backend/open_webui/retrieval/web/main.py)、[Tavily 适配](https://github.com/open-webui/open-webui/blob/6a18585ff4c2e5f6805f682222cfbc46dc669ef8/backend/open_webui/retrieval/web/tavily.py)、[工具注册](https://github.com/open-webui/open-webui/blob/6a18585ff4c2e5f6805f682222cfbc46dc669ef8/backend/open_webui/utils/tools.py) | 搜索适配器统一返回链接、标题、摘要；联网工具受全局配置、能力和权限控制 | 统一来源数据、按配置暴露工具 |
| [LibreChat 文档](https://www.librechat.ai/docs/features/web_search)、[搜索结果回调](https://github.com/danny-avila/LibreChat/blob/e1dfc10449ff713faffacd60273fddcfe2c0a698/api/server/services/Tools/search.js) | 搜索、正文抓取、可选重排分离；来源与工具调用关联并推送给界面。文档允许关闭重排，也支持 Tavily 同时承担搜索和抓取 | 两个文本工具各司其职，保留来源；首版省去重排 |
| [Perplexica，现名 Vane：图片搜索](https://github.com/ItzCrazyKns/Perplexica/blob/348feca3e378fb4157b217724ed508dc707f853f/src/lib/agents/media/image.ts)、[SearXNG 请求](https://github.com/ItzCrazyKns/Perplexica/blob/348feca3e378fb4157b217724ed508dc707f853f/src/lib/searxng.ts) | 图片查询单独走 Bing/Google Images 引擎，返回图片地址、来源页和标题；SearXNG 请求有 10 秒超时 | 将图片搜索与正文搜索分开，保留图片原始来源；本项目额外实现本地导入 |

这些是参考模式，不代表已审计这些项目全部代码。Vane 用额外 LLM 改写图片查询，本项目已有工具调用模型，首版省去这次模型调用。

### 真实网络探针

只调用公开接口，没有使用用户密钥。原始临时证据在 `/tmp/web-access-research-20261015/`，关键结论留在本文；临时目录可能被系统清理。

| 调用 | 实测结果 | 对方案的影响 |
| --- | --- | --- |
| 本会话默认 `web_search` | 报没有可用服务商 | 不依赖 Pi 会话配置作为应用运行配置 |
| 本会话 `fetch_content` 访问 GitHub raw | 因域名解析到 `198.18.0.227` 被拒 | 本机 fake-IP 必须纳入实际部署验收 |
| 匿名 Exa MCP，查询 TypeScript 官方文档，3 条 | HTTP 200，约 0.94 秒；`result._meta["ai.exa/rateLimited"] = true`，文本明确说明免费额度耗尽 | 免费通道不作为默认主链路；HTTP 200 不等于成功 |
| 经当前 `web_search(provider=exa)` 调用 | 返回“没有结果” | 调研缺陷 R1：限流被误报为空结果。若以后接入 Exa，必须检查 MCP 元数据与业务错误 |
| Jina Reader 读取 `https://example.com` | HTTP 200，约 1.07 秒，返回标题与正文；同时带可能未加载完整的警告 | 可用作显式启用的正文回退；警告需要保留，不能当作完整性保证 |
| Openverse 搜索 `mountain landscape`，限制 `cc0,pdm,by` | HTTP 200，约 3.12 秒，取回 3 条，含作者、许可、来源页和原图 URL | 可作为图片素材候选来源 |
| 下载其中第一张 Flickr 原图 | HTTP 200，约 1.85 秒，JPEG，203376 字节，文件签名与类型一致 | 当前网络环境中，素材候选到图片字节的链路能跑通 |
| Tavily 免密钥 Search（带 `X-Tavily-Access-Mode: keyless`），英文动漫角色查询 | HTTP 200，约 6.7 秒，3 条结果 + 5 张图片；每条结果另带自己的图片列表（3/5/59 张） | 免密钥可用，且图片覆盖动漫角色 |
| 同上，中文查询「泉此方 ラッキースター」 | HTTP 200，约 10.2 秒；结果含日文维基与 Bangumi；图片为 wikia、萌娘百科的泉此方角色图，带描述 | 用户提出的「泉此方」类查询能够命中 |
| Tavily 免密钥 Extract 读取 example.com | HTTP 200，约 0.62 秒，正文 958 字符，`failed_results` 为空 | 正文读取与搜索共用同一免密钥通道 |
| 下载上述「泉此方」候选中的 6 个不同来源 | 5 个成功（webp/jpeg/png，21–498 KB，0.5–1.4 秒），1 个 404 | 候选会失效，需允许单个失败并换候选 |
| wikia 的 `.png` 地址 | 实际返回 `image/webp` | 扩展名必须按字节签名判定，不能信 URL 后缀 |
| Openverse 查询 `Izumi Konata` | 12 条，全部是 cosplay 与手办照片；查询 `Lucky Star anime character` 为 0 条 | Openverse 无法替代通用图片搜索 |
| Wikimedia Commons 查询同一角色 | 仅 cosplay 与展会照片 | 同上 |
| Exa 免费 MCP 重测（2 次） | HTTP 200，1.9–2.4 秒，`rateLimited` 为 false，返回真实结果 | 免费通道时好时坏，只能作次级来源 |
| DuckDuckGo 图片接口 `i.js` | HTTP 202，0 条结果 | 免密钥直连不可用 |
| Bing 图片 HTML 抓取 | HTTP 200 但没有 `murl` 字段 | 抓取方式不可用，不进方案 |
| 公共 SearXNG 实例（JSON 格式） | 返回 HTML 或直接连接失败 | 要用 SearXNG 就得自托管 |
| Safebooru JSON API 查 `izumi_konata` | HTTP 200，3 条，含原图直链；Danbooru 无凭据为 403 | 动漫图专用来源可用，但属同人/版权作品，默认不启用 |

上述耗时均为单次探针，不是性能基准、成功率或服务承诺。探针通过直接 HTTP 执行，未经过拟实现的应用安全层，不能替代其验收。

### Tavily 免密钥与免费额度

官方文档明确：免密钥模式只需 `X-Tavily-Access-Mode: keyless` 请求头，Search 与 Extract 均免费，响应 schema 与带 key 相同；超限后注册免费 key（每月 1000 credits，无需信用卡）即可提高限额，代码无需改动。按官方计价，`basic` 搜索每次 1 credit，`basic` 提取每 5 个成功 URL 收 1 credit；开发 key 限速 100 请求/分钟，超限返回 429 与 `Retry-After`。

对本项目意味着：默认零配置即可运行，1000 credits/月约等于 1000 次搜索或约 5000 次单页提取。官方额度与限速会变，代码不写死这些数字，只在配置里给默认预算。

## 3. 服务选择与取舍

| 能力 | 首版选择 | 原因与边界 |
| --- | --- | --- |
| 网页搜索 | Tavily Search 免密钥，`basic`，最多 5 条 | 零配置；结构化结果；不额外调用回答模型。免密钥共享限额且更慢 |
| 网页正文 | Tavily Extract 免密钥，`basic`，每次 1 个 URL | 与搜索同通道；须同时检查 `results` 与 `failed_results`，HTTP 200 也可能全部失败 |
| 正文回退 | 可选 Jina Reader，仅一次 | 无 key 探针已通过。目标 URL 会发给另一家服务，管理员明确启用后才允许回退 |
| 图片素材（默认） | Tavily `include_images` 与每条结果的 `images` | 覆盖动漫角色等通用查询；但无许可元数据，授权需自行确认 |
| 图片素材（许可可核验） | Openverse Images API，可选追加 | 过滤 CC0/PDM/CC BY 并返回作者与来源；覆盖仅限开放许可素材，动漫角色类基本没有 |
| 图片落地 | 应用服务端下载为工程本地文件 | 预览和发布引用本地资源，避免运行时依赖外链、防盗链与第三方可用性 |

Tavily 的 `include_answer=false`、`include_raw_content=false`、`include_images=false`、`auto_parameters=false`，显式固定 `search_depth=basic`。搜索只取摘要，需要时再读正文。根据官方文档，basic 搜索当前为每次 1 credit；这里只约束调用量，不承诺货币成本或永久免费额度。

不默认部署 SearXNG。它虽然开源且无需商业 key，但增加一个常驻服务，也要维护搜索引擎配置、JSON 接口、出口与验证码问题。若以后明确要求自托管，可在相同工具结果契约后替换搜索实现。

Exa 免费 MCP 可作次级文本搜索来源：重测已恢复正常，但本机当天早些时候被限流过，属共享限额，接入时必须正确解析其 `_meta` 与错误，不能再报成「没有结果」。DuckDuckGo 图片接口（202、0 条）、Bing 图片 HTML 抓取（无 `murl`）、公共 SearXNG 的 JSON 格式（返回 HTML 或直接失败）、无凭据的 Danbooru（403）实测都不可用，因此都不进方案。Safebooru 的 JSON API 可免密钥取到动漫图，但内容属同人/版权作品，默认不启用。未来增加服务商时仍保持少量显式适配，不先建设插件框架。

如果必须完全无 key，可选匿名搜索与 Jina/Openverse 组合，但需要接受文本搜索可用性较弱；不能把这个选项描述成与正式 API 同等可靠。

## 4. 模型工具契约

| 工具 | 模型输入 | 返回的核心数据 | 默认上限 |
| --- | --- | --- | --- |
| `webSearch` | `query` | `title, url, snippet, provider, retrievedAt` | 5 条，单条摘要 500 字符，整个结果 4000 字符 |
| `readWebPage` | `url` | `title, requestedUrl, finalUrl（上游提供时）, content, provider, retrievedAt, truncated, warnings` | 正文 8000 字符，显式标明截断 |
| `searchImages` | `query, source?: web\|open` | `candidateId, title, width, height, sourcePage, creator, license?, licenseUrl?, attribution?, licenseKnown` | 6 条，不返回 base64 |
| `importImage` | `candidateId` | `path, src, bytes, sourcePage, attribution, creditsPath, licenseKnown` | 只接受当前生成任务的候选；路径由服务端决定 |

成功、空结果、失败使用不同状态：`ok / empty / error`。失败带稳定错误码，如 `quota / auth / timeout / unavailable / blocked-url / invalid-response / too-large`。不把 401、429、HTML 验证码、MCP 限流提示或正文提取失败翻译成“没有搜索结果”。错误文案不含密钥与完整上游响应。

工具的启用配置在一轮生成开始时固定。未启用时不向当前模型宣称具备该能力；历史中已有的联网工具结果需要保留并能正常读取，不能因为后来关闭开关而让 `validateUIMessages` 拒绝整个会话。

模型指令明确：需要最新资料、具体事实和真实素材时使用工具；资料需要引用来源；网页是外部数据，不能提升为系统指令；没有查到就说明缺口。图片失败可以使用 CSS 或已有本地素材，不编造 URL、检索结果或许可。通用网络档的图片必须保留来源页链接并提示授权状态未知，不得声称已获得授权。

## 5. 图片进入工程

1. `searchImages` 将完整候选保存在当前生成任务的有界 Map。模型获得不透明 `candidateId`，不能通过 `importImage` 指定任意 URL 或任意目标路径。
2. 图片分两档，导入时都写入来源与获取时间：
   - **许可可核验档**（Openverse）：请求与本地结果都按 CC0、PDM、CC BY 过滤，优先 CC0/PDM；NC、ND 与未知许可不导入。索引中的许可信息仍是参考，不能替代原始来源核实，也不覆盖商标、肖像等权利。
   - **通用网络档**（Tavily 图片结果，默认启用）：覆盖动漫角色等真实需求，但没有许可元数据。必须记录来源页 URL 与可用时的 creator，工具结果与署名页都标注「授权状态未知，请自行确认」，不能宣称可商用。提供 `WEB_ACCESS_STRICT_LICENSE` 开关，打开后只允许许可可核验档，供确有合规要求时使用。
   - 两档都禁止把候选描述当事实写进署名；下载失败或 404 时换下一个候选，不因单个候选失败放弃整次导入。
3. 导入时重新检查候选有效性、目标地址、跳转、流式大小、响应 MIME 与文件签名。首版只收 JPEG、PNG、WebP，拒绝 SVG、HTML 和不匹配的内容。
4. Vue/React 放 `public/assets/<sha256>.<ext>`，返回 `src: "./assets/<sha256>.<ext>"`；HTML/多文件应用放 `assets/<sha256>.<ext>`。由工具提供路径，模型直接使用。多页面与路由相对路径必须通过真实预览验证。
5. 在同目录维护平台生成的 `sources.json` 与 `credits.html`，保留图片、作者、来源页、许可链接、获取时间。模型应在页面上加入可访问的素材署名链接；许可要求署名的图片必须在浏览器验收中检查呈现。
6. 图片和来源清单在现有 `withAppWriter` 与有效生成租约下提交。下载在锁外进行，落盘前重新检查取消与租约；使用临时文件、原子替换和失败清理，不能留下半张图片或成功状态的失配记录。同一候选重复导入返回既有文件，避免重复计费或占空间。

图片单文件 2 MiB（单次下载上限），不设每轮张数与累计上限，最终仍服从工程总大小 16 MiB、最多 256 个文件。普通文本仍保留 256 KiB 上限。平台生成的素材清单与署名文件禁止通过文本工具篡改。

需要同步修改的现有行为：

- `workspace.ts` 只有 UTF-8 文本读写，需要补受限二进制写入，复用现有路径、软链接、项目配额和原子替换检查。`readFile` 对图片返回明确的非文本说明，不能把字节误当正文。
- `artifacts.ts::sourceDigest` 当前调用 `readProjectFile`，会把每个文件按 UTF-8 读取，且受 256 KiB 文本限制。指纹必须改为原始字节计算；同步使旧构建缓存失效。
- 构建 staging、Vite public 复制、HTML 发布、源码 ZIP、预览 MIME 均要贯通。当前 `preview.ts` 已支持 JPEG/PNG/WebP 和 `nosniff`，优先复用。

## 6. 可靠性、安全与上下文预算

- 部署配置以 `WEB_ACCESS_ENABLED` 为总开关，默认关闭；搜索/正文在 `TAVILY_API_KEY` 有效配置时注册，图片可以独立启用。Jina 回退默认关闭。启用时明确告知查询和目标 URL 会发送给所选服务商。
- 密钥只留服务端环境，不进入工具参数、模型上下文、日志、工程、预览或下载包。首版服务商地址固定，不开放任意 `baseUrl`，带凭据请求禁止自动跨源重定向。
- 服务商固定端点与模型/图片候选给出的目标地址分开管理。正文 URL 只允许公网 HTTP(S)，拒绝用户信息、内网、环回、链路本地和元数据地址；托管提取服务的后续请求由该服务负责，本地预检不能保证控制其全部跳转。
- 对本机直接下载图片，每跳最多共 3 次重定向，每次重新验证协议、端口、DNS 全部地址与目标 IP；连接绑定已验证 IP，保留正确 Host/SNI，避免“先检查 DNS 再由 fetch 重新解析”的空隙。默认端口仅 80/443。
- 默认拒绝私有与保留网段。本机 fake-IP 使用显式可信代理部署选项，由代理解析并在出口阻止内网访问；仍禁止字面量内网目标。若改用窄 CIDR 例外，必须是管理员明确配置，且保留其他保护。不能把所有主机都设为 trusted 或全局关闭 SSRF。
- 新增依赖控制在需要的底层能力内，候选为 `undici`（连接/代理）、`ipaddr.js`（完整 IP 分类）、`file-type`（文件签名）；沿用现有 Zod 验证上游结构，不增加抓取框架。实现时确认直接依赖，不能依赖 Next 的内部包或偶然的传递依赖。
- **不设调用次数预算**（2026-10-19 取消，取代最初的每轮搜索 3 次/读正文 3 次/搜图 2 次/导入 4 次）：模型检索多少次自己决定，我们不阻断、也不因为次数给出失败。相同请求在本轮复用 Promise，包括失败结果，避免同一次检索重复消耗上游额度。上游额度与限速由服务商负责（Tavily 免密钥共享额度、429 与 `Retry-After`）。
- 单次搜索/搜图默认 20 秒，正文/下载 15 秒，连接、响应体读取和可选回退共享该次工具期限（免密钥搜索实测 6.7–10.2 秒，预算必须留出余量）。继承生成取消信号；429 按 `Retry-After` 处理，免密钥限额与主服务业务错误都不盲目重试，也不自动改用其他商业服务。正文可选回退最多一次。
- 服务响应按字节流设上限，不能只信 `Content-Length`。搜索 JSON 默认 1 MiB、正文响应 2 MiB、图片按 2 MiB 限制。格式不符立即停止。
- 单次导图不设张数与累计上限，单张仍限 2 MiB；工程总大小与文件数配额继续生效。
- 联网结果按单次调用裁剪：搜索一次最多约 4000 字符、读正文一次最多 8000 字符，不做同轮累计上限。工具 schema 必须算进 `contextOverheadTokens`。
- 首版复用现有工具状态与折叠结果展示，输出短小可读。不增加来源侧栏；确保引用链接安全渲染，并对现有 UI 做浏览器验收。
- 记录工具名、服务商、耗时、结果数/字节、错误码和上游提供的 usage，不默认记录完整查询与正文。不把探针成功等同于内容真实、完整或可商用。

## 7. 实施单元与验收

采用 multi-phase-plan 技能。执行指导为 `/home/zdan/.agents/skills/multi-phase-plan/references/execution.md`。本文是方案，不代表实施、提交、推送或部署已经获批。

阻塞输入是 Tavily 的真实部署凭据与主机出口策略。统一结果、配置、地址/字节边界先稳定，再接入模型与图片。共享可变文件是 `config.ts`、`agent.ts`、`workspace.ts`、`artifacts.ts`，由主实施者单独整合；首版顺序实施即可，无需多作者并行。公开源码调研和只读探针已完成，不涉及迁移、端口或数据库写入。

依赖为 `U1 → U2 → U3 → U4`。以下状态均为待实施。

| 单元 | 负责人、输入与写入边界 | 完成目标与验收 | 交接 |
| --- | --- | --- | --- |
| U1 工具契约与网络边界 | 主实施者；本文与基线；新增 `src/server/web-access/{types,http,config}.ts`、修改 `config.ts` 与 `.env.example`，以及对应单测 | Zod 结果契约、配置、取消、超时、体积、代理和地址策略；覆盖 IPv4/IPv6、映射地址、DNS 重绑定、跳转到内网、流式超限；所有失败有稳定错误码且无密钥 | 给 U2 提供可执行网络层、实际 diff、单测日志和未解决的网络假设 |
| U2 搜索与正文 | 主实施者；U1；`web-access/{search,read,tools}.ts`、`agent.ts` 与相关测试 | 四类状态正确区分；免密钥模式零配置跑通真实搜索与读正文，配置 key 后同一路径仍通过；429/`Retry-After`、免密钥限额与上游业务失败都映射为可区分错误；Jina 关闭/开启、共享超时与取消均正确；schema 开销与单次输出裁剪生效；关闭工具后带历史工具消息仍能继续生成 | 给 U3 交付可注册的工具与单次上限；日志不含 key 与完整正文 |
| U3 图片与构建 | 主实施者；U1/U2；`web-access/{images,import}.ts`、`workspace.ts`、`artifacts.ts` 及素材测试 | 两档来源都按契约导入；用真实「泉此方」类查询下载成功；扩展名按字节签名判定（`.png` 实为 webp）；单个候选 404 时换候选；越界 URL/路径、NC/ND、伪图片、超限、重复导入、取消/租约过期都符合契约；严格许可开关生效；二进制写入不放宽文本上限；大于 256 KiB 的合法图片能构建，改变图片字节使指纹变化 | 给 U4 提交含图片与署名页的可预览样例，以及构建/下载/发布测试记录 |
| U4 合并验收 | 主实施者负责最终验收；U2/U3；`tests/integration/*web-access*`、`tests/e2e/*web-access*`、更新本文 | HTML、Vue、React 各生成一例，真实浏览器图片 `naturalWidth > 0`、引用与署名可访问；预览、测试发布副本与 ZIP 均有资源；断网、429、工具关闭和取消不产生伪成功；模型供应商支持这些工具调用；执行所需回归 | 交付最终 diff、真实检查与剩余限制；仅在实际证据齐全后标记完成 |

实施证据统一存放 `runtime/evidence/web-access/`，记录测试所用 revision 与未提交 diff 身份、脱敏日志和截图。使用隔离测试端口与测试库，不发布到真实共享部署。来源未存在于基线，无新增功能性能基准可比较；已有生成链路需要回归。

拟执行的验收命令包括 `npm run type-check`、`npm test -- <新增测试文件>` 和 `npm run test:e2e:isolated -- <新增浏览器用例>`。修改 TSX 时再执行仓库要求的 `npm run check:ui`、`npm run check:e2e` 与 `npm run test:e2e:dev`。这些命令本次尚未执行，因为没有实现代码。

性能验收在真实服务上对同一组中英文查询各跑 5 次，记录成功数、P50/P95、usage、返回长度与请求次数；小样本只用于发现明显问题。硬性门槛是取消/超时生效、无隐式重试、单次上限不超限、能走完素材闭环。若真实服务质量不满足需求，先调整选用的服务，不增加更多抽象掩盖失败。

## 8. 文档与未验证项

官方 API 文档：

- [Tavily 免密钥使用](https://docs.tavily.com/documentation/keyless.md)：`X-Tavily-Access-Mode: keyless`，响应与带 key 一致。
- [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search)，调研读取其 Markdown/OpenAPI 版本。
- [Tavily Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract)，特别注意 HTTP 200 下的 `failed_results`。
- [Tavily Credits & Pricing](https://docs.tavily.com/documentation/api-credits.md) 与 [Rate Limits](https://docs.tavily.com/documentation/rate-limits.md)：1000 credits/月免费、basic 搜索 1 credit、429 与 `Retry-After`。
- [Openverse API](https://docs.openverse.org/api/) 与 [在线 API 参考](https://api.openverse.org/v1/)。
- [Openverse 身份认证与限流](https://docs.openverse.org/api/reference/authentication_and_throttling.html)，部署时核对当前规则，不在代码里假定匿名额度固定。

未验证：带 key 的额度路径、当前生成模型实际调用四个新工具的表现、代理下拟实现安全下载层、最终工程预览/发布/ZIP。免密钥通道的稳定性与真实限额只能靠长期观测判断，本机当天出现过限流后恢复，因此必须保留清晰的失败提示与可选的 key 升级路径。Openverse 不保证每个候选原图都存活，Jina 不保证动态页面完整。首版不承诺登录网页、付费墙、PDF、视频、深度研究或图片语义识别。

## 9. 实施记录（2026-10-15）

### 新增与修改的文件

| 文件 | 内容 |
| --- | --- |
| `src/server/web-access/types.ts` | 错误码、工具结果状态（ok/empty/error）、工具输出类型 |
| `src/server/web-access/network.ts` | 地址策略：永远拒绝的类别、可放行的显式网段清单、逐地址校验、可信端点与代理解析 |
| `src/server/web-access/http.ts` | 传输层：undici、地址绑定、逐跳重定向、超时、按字节限流、状态码映射 |
| `src/server/web-access/config.ts` | 端点常量与单次调用上限 |
| `src/server/web-access/tavily.ts` | 免密钥/带 key 搜索与正文提取，zod 校验上游响应 |
| `src/server/web-access/read.ts` | 网页正文与可选 Jina Reader 回退 |
| `src/server/web-access/images.ts` | 候选模型、许可白名单、Tavily 图片与 Openverse 两个来源 |
| `src/server/web-access/import.ts` | 下载、签名校验、素材目录、清单与署名页 |
| `src/server/web-access/tools.ts` | 四个模型工具、缓存、指令文本、会话状态 |
| `src/server/binary.ts` | 图片签名与二进制判定（workspace 与 web-access 共用） |
| `src/server/config.ts` | 7 个 `WEB_ACCESS_*` 环境变量、代理与网段校验 |
| `src/server/agent.ts` | 按开关注册工具；校验用工具超集；`readFile` 改用二进制安全读取 |
| `src/server/workspace.ts` | `readProjectFileBytes`、`writeProjectFileBytes`、`readProjectFileAsText`、`writePlatformAssetFile`、平台素材文件保护 |
| `src/server/artifacts.ts` | 构建指纹按字节计算；源码导出包按字节读取 |
| `.env.example` | 联网配置与 fake-IP 双网段说明 |

### 与方案的差异（都是有依据的调整）

1. **网络层依赖**：直接用 `undici` + `ipaddr.js`（两者已在 `package.json` 中且已安装），未引入 `file-type`，自带签名判定（`src/server/binary.ts`）。
2. **服务商端点与模型地址分开校验**：Tavily/Jina/Openverse 是部署者固定的 HTTPS 端点，跳过本地地址校验（免密钥通道在 fake-IP 机器上才可用）；模型给的网页与图片地址做完整逐跳校验。带凭据的 POST 一律不跟随重定向，避免密钥被转发。
3. **`readWebPage` 先本地校验再交给服务商**：否则会把内网地址转发给第三方（实现中发现并修正，有测试覆盖）。
4. **可放行网段用显式白名单而非地址类别**：`ipaddr.js` 把 `198.18.0.0/15` 归在 `reserved`，按类别放行会连私网一起放开；现在只能放行 benchmarking/documentation 网段内的子网。
5. **fake-IP 需要同时放行 A 与 AAAA**：本机 DNS 返回 `198.18.x` 与 `2001:2::x` 两类地址，配置只写一个会被拒；已在 `.env.example` 说明两个都要写。
6. **图片素材目录**：Vite 工程写 `public/assets`，HTML/多文件应用写 `assets`；平台文件保护按路径规则（`assets/credits.html`、`assets/sources.json`）而不是 `.paimeng-` 前缀，否则预览里无法链接。
7. **图片搜索超时 20s → 30s**：免密钥 `include_images` 实测 17.2 秒。
8. **源码导出包改为按字节读取**：`downloadApp` 原来按 UTF-8 读所有文件，加入图片后 ZIP 里的图片会损坏（集成测试发现并修复）。
9. **`ensureWritable` 上移**：`importImage` 需要在下载完成后、落盘前复核生成租约；下载仍在写入锁外。
10. **工具校验收集**：模型只看到已启用的工具，`validateUIMessages` 与会话转换用超集，关闭开关后历史里的工具结果仍可读取。
11. **素材名称改用来源页标题（方案 B）**：Tavily 图片项带 `title`（页面名，如 `Konata Izumi | Lucky Star Wiki`）与 `description`（服务商生成的机器翻译，实测出现过俄文）。原实现把描述当名称，署名页会出现俄文或 `image.jpg` 之类的名字；现在名称优先用页面标题、描述单独保留给模型参考，并新增 `sourceIsPage` 区分「有来源页」与「只有图片地址」（`tests/web-access-images.test.ts` 覆盖）。方案 A（优先带落地页的候选）未做，仍按 Tavily 原始顺序（顶层图片在前）。
12. **取消自设调用额度（2026-10-19）**：实测生成时应用会转述「本轮图片检索配额只有 2 次」「联网返回内容已达上限」并因此不再找素材。删掉 `webAccessLimits.budgets` 与累计计数（`turn.outputChars`、`turn.maxImageBytes`）、连带删掉 `budget-exceeded` 错误码与 `importedBytes` 参数；`search`/`page` 的字符上限改为纯单次调用裁剪。保留 `WEB_ACCESS_*` 与工程配额不变。

### 验证证据

| 检查 | 命令或方式 | 结果 |
| --- | --- | --- |
| 类型 | `npx tsc --noEmit --incremental false` | 通过 |
| 全量单测与集成 | `npx vitest run` | 48 个文件 / 419 项通过 |
| UI 与 E2E 静态检查 | `npm run check:ui`、`npm run check:e2e` | 通过 |
| 免密钥真实搜索与缓存 | 真实调用，证据 `runtime/evidence/web-access/u2-live-probe.txt` | 2.8 秒返回 3 条真实结果；同查询缓存命中 0 毫秒 |
| 真实正文读取 | 证据 `runtime/evidence/web-access/u2-live-read.txt` | 日文维基正文 1.56 秒（8000 字符截断）；example.com 782 毫秒 |
| 内网地址拒绝 | 同上 | 云元数据地址在发出请求前被拒（blocked-url） |
| 真实图片检索与导入 | 证据 `runtime/evidence/web-access/u3-live-probe.txt` | 6 个候选；3 个中 2 个成功落盘（122 KB / 29 KB），1 个失效页面被拒；清单与署名页生成，标注授权未知 |
| 浏览器与交付 | `npx vitest run tests/integration/web-access-images.test.ts` | 真实 Chromium 中 `naturalWidth > 0`；署名页可访问；发布目录与 ZIP 内图片字节一致 |
| 素材名称（方案 B） | 真实调用，证据 `runtime/evidence/web-access/u3b-title-probe.txt` | 名称由俄文描述变为 `Konata Izumi \| Lucky Star Wiki \| Fandom`、`泉こなた - Moegirlpedia`；无落地页的候选标为 `sourceIsPage=false` |

### 尚未完成（U4 剩余部分）

- 真实模型调用这四个工具的端到端生成未验证（需要模型凭据与开发库；本次未执行）。
- Vue/React 工程的真实 Vite 构建未验证（`public/assets` 路径仅有单测断言）。
- 断网、真实限流（429）、关闭开关后的历史会话、生成中途取消这四类场景未做真实复现（单测覆盖了单次上限、错误码与取消）。
- 通用网络档的来源排序（方案 A）未做（已有明确决策）：Tavily 顶层图片（多无落地页）仍排在前面，实测一次 6 个候选里有 5 个只能给图片地址，带 pixiv/wiki 页面的候选可能被挤掉。已做的是方案 B：名称改用来源页标题，无落地页时署名页写明「未提供页面链接」并给出图片地址，工具结果里用 `sourceIsPage=false` 明确标注。若要改成「可核实优先」，只需调整 `web-access/images.ts` 的候选排序。
- 正文返回内容是服务商给出的 markdown，含导航等噪声，未做二次提取。
- 模型端的界面展示沿用现有工具状态与折叠结果，未做专门排版。
- 既有语义未改：一轮生成若没有写任何文件仍会判为「Agent 未保存任何文件」，因此纯联网问答会失败。
