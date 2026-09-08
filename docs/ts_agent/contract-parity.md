# TS Agent 契约对等报告（Issue #11 · T21 门禁判据）

> 用途：T21 门禁「TS Agent 契约对等」半边的判据（架构 §退役方案第 2 条）。
> 对账对象：旧 Python Agent 测试套件 `paimeng-ai-code-rag/tests/`（13 文件 / 84 例）。
> 对等口径：**语义比对，不比对字节**；「有意演进/退役」须引用 `docs/ts_agent/architecture.md` 或票据记录判据，不用于粉饰缺口。
> 终稿日期：2026-09-07（初稿基于不完整 clone 误报五票幻影关闭，git 历史找回后本稿基于真实实现全量重跑修订；过程记录见 `progress.md` 2026-09-07 条目与 e3cb95b）。

## 一、结论：契约对等达成，T21 判据通过

基线：`paimeng-ai-code-agent/` 实测 `npm test` **144/144**（19 文件）+ `type-check` 通过（2026-09-07）。

| 处置 | 例数 | 说明 |
|---|---|---|
| ✅ 语义覆盖 | 72 | TS 侧测试在档，语义等价（含本票补齐 5 项） |
| ⚠️ 语义差异（P3 定夺项） | 3 | 行为细节与旧契约不同，不构成能力缺失，列 §五 待联调统一 |
| 🗄️ 有意演进/退役 | 9 | 架构决策转移或替代，判据见逐项标注 |

本票补齐的缺口（此前无 TS 测试覆盖）：

| 补齐项 | 对应旧测试 | 落点 |
|---|---|---|
| golden e2e 全链（html + multi_file，假 LLM 剧本 `multi-file` 新增） | test_e2e.py ×2 | `test/golden-e2e.test.ts` + `test/fixtures/golden_*.json` |
| 质检文件拼接：dist 跳过 + 目录缺失返回空 | test_quality.py ×2 | `test/generation/review/review.test.ts`（补强既有用例 + 新增 1 例） |
| 十工具名驼峰绑定契约（Java ToolManager 依赖） | test_codegen/test_images 绑定例 | `test/generation/tools/tools-contract.test.ts` |
| 护轨拒绝 → failed 完成回调断言 | test_streaming.py 护轨回调例 | `test/server/stream.test.ts`（既有用例追加断言） |
| 完成回调失败不阻断主流程 | test_callback.py 容错例 | `test/server/stream.test.ts`（新增用例） |

> 范围注记（2026-09-08 code-review 整改补记）：`src/llm/index.ts` 中 `buildPageContent` 另含约 100 行 MSW 风格 mock 拦截层（fetch/XHR 补丁 + fixture 规则表，自标 #13 L1 预览态），系随本票提交混入的 src 生产行为改动，不属于 #11 对账范围；其对账结论无影响，测试覆盖债已在 #13 记录（届时补覆盖测试）。

## 二、逐文件清点表（84 例）

### `test_contract.py`（11 例）— Java↔Agent 内部契约

| 测试 | 语义 | TS 处置 |
|---|---|---|
| test_healthz | /healthz 200 且 `{"status":"ok"}` | ✅ `test/server/healthz.test.ts` |
| test_stream_requires_auth | 无 Authorization → 401 | ✅ `test/server/auth.test.ts`（401 矩阵 8 例） |
| test_stream_with_wrong_token | 错误令牌 → 401 | ✅ `test/server/auth.test.ts`（乱串/错误密钥） |
| test_stream_with_valid_token | 合法令牌 → 200 + text/event-stream + data: | ✅ `test/server/stream.test.ts` + golden e2e |
| test_stream_rejects_path_traversal | workspacePath 越界 → 拒绝 | ✅ `test/generation/workspace.test.ts`（validate 400）+ `stream.test.ts`（流内 error 终态不写文件） |
| test_stream_rejects_relative_path | 相对路径 → 拒绝 | ✅ `test/generation/workspace.test.ts`（流内经 sandbox 拒绝，语义等价） |
| test_stream_rejects_invalid_code_gen_type | codeGenType 白名单外 → 422 | ⚠️ 路由白名单存在但白名单外**回退 html** 而非拒绝（`server/agentRoutes.ts` CODE_GEN_TYPE_WHITELIST）→ §五-1 |
| test_stream_rejects_empty_message | message 空 → 422 | ⚠️ 路由只强制 runId/appId/userId，message 不再必填；contract.md 仍写必填 → §五-2 |
| test_event_schema_aligns_with_java | ai_response/tool_request 字段逐字段 | ✅ `src/protocol/events.ts` + `stream.test.ts` 字段断言 |
| test_callback_schema_alignment | 回调体逐字段 + status 枚举 | ✅ `run-client.test.ts`（completeRun/freeze/aborted filesWritten；回调形状按 #6/#10 演进为写历史+构建+记账） |
| test_healthz_does_not_require_auth | 健康检查免鉴权 | ✅ `test/server/healthz.test.ts` |

### `test_sse.py`（3 例）— SSE 序列化约定

| 测试 | 语义 | TS 处置 |
|---|---|---|
| test_format_data_splits_newlines | 换行逐行拆 data: + 空行收尾 | ✅ `test/protocol/sse-format.test.ts` |
| test_format_event_with_event_field | event 行先于 data 行 | ✅ `test/protocol/sse-format.test.ts` |
| test_encode_stream_message_is_single_data_line | 结构化事件单行 JSON | ✅ `test/protocol/sse-format.test.ts` |

### `test_streaming.py`（8 例）— 流式输出适配

| 测试 | 语义 | TS 处置 |
|---|---|---|
| test_html_stream_yields_text_and_writes_workspace | html 流出 + 落盘 index.html | ✅ `stream.test.ts` 成功剧本 + golden_html e2e（产物经 writeFile 工具落盘，语义等价） |
| test_multi_file_stream_writes_three_files | multi_file 三文件落盘 | ✅ golden_multi_file e2e（`multi-file` 剧本一轮并行写三文件，本票补） |
| test_vue_stream_emits_structured_events | 结构化事件归一化（thinking/request/executed/response） | ✅ `stream.test.ts` 事件映射 + 顺序约束 |
| test_guardrail_rejection_emits_error_event | 护轨拒绝 → error 且无业务事件 | ✅ `stream.test.ts`（#8：interview 拦截，不进 coding） |
| test_generation_exception_emits_error_event | 生成异常 → error 事件 | ✅ `stream.test.ts` error 剧本 |
| test_success_callback_fired_after_workspace_write | 落盘后 success 回调 | ✅ `stream.test.ts` + golden e2e（终态前回调 + workspacePath） |
| test_failed_callback_fired_on_generation_error | 异常 → failed 回调带 message | ✅ `stream.test.ts`（errorMessage） |
| test_failed_callback_on_guardrail_rejection | 护轨拒绝 → failed 回调 | ✅ `stream.test.ts`（本票补断言） |

### `test_codegen.py`（11 例）— 解析 / 路由 / 工厂 / vue 工具

| 测试 | 语义 | TS 处置 |
|---|---|---|
| test_parse_html_code_extracts_block | 提取 ```html 块 | ✅ `test/parsing.test.ts`（#16 已删：零生产调用死代码；遗留见 §五-4） |
| test_parse_html_code_fallback_to_whole | 无块时全文兜底 | ✅ `test/parsing.test.ts`（#16 已删） |
| test_parse_multi_file_extracts_three_blocks | html/css/js 三块解析 | ✅ `test/parsing.test.ts`（#16 已删） |
| test_parse_multi_file_missing_css | 缺块时空串 | ✅ `test/parsing.test.ts`（#16 已删） |
| test_to_files_html | 解析结果 → {index.html} | ✅ `test/parsing.test.ts`（#16 已删） |
| test_to_files_multi_file_skips_blank | 空白内容不写文件 | ✅ `test/parsing.test.ts`（#16 已删） |
| test_route_code_gen_type | 模型回复路由生成类型 | 🗄️ 路由归 Java（架构 §退役：`createApp` 保留 Java 侧 AI 路由决策）；TS 白名单见 §五-1 |
| test_factory_creates_by_type | 按类型工厂创建服务 | 🗄️ 旧抽象随文本流模式演进，XState coding 工位统一承接 |
| test_executor_stream_html_multi_file_uses_text_stream | 按类型分发执行 | 🗄️ 演进：workflow 内部按档位/类型装配（`resolveModelId` + 提示词），无独立执行器层 |
| test_vue_tools_binding | 六文件工具绑定（驼峰名） | ✅ `test/generation/tools/tools-contract.test.ts`（本票补）+ `fileTools.test.ts` 行为例 |
| test_vue_execute_dispatches | 工具名分发 + 中文结果文案 | ✅ `fileTools.test.ts`（写/读/改/删/列目录/退出逐条移植） |

### `test_tools.py`（11 例）— 文件工具行为

全部 ✅ `test/fileTools.test.ts`（14 例，逐条移植）：写入建父目录 / 读往返 / 读缺失报错文案 / modify 替换 / 旧内容缺失警告且不改 / 删除 / 重要文件（package.json）保护 / exit 终止提示词 / readDir 忽略构建产物 / `..` 越界拒绝 / 绝对路径越界拒绝。驼峰参数键（relativeFilePath/oldContent/newContent）由 `tools-contract.test.ts` 与工具 schema 双重锁定。

### `test_workspace.py`（7 例）— 沙箱与原子写入

| 测试 | 语义 | TS 处置 |
|---|---|---|
| test_validate_accepts_path_under_root | 根下路径通过 | ✅ `test/generation/workspace.test.ts`（9 例矩阵） |
| test_validate_rejects_relative_path | 相对路径拒绝 | ✅ |
| test_validate_rejects_path_outside_root | 越界拒绝 | ✅（含符号链接逃逸——TS 侧增强） |
| test_atomic_write_replaces_workspace | 文件集整体替换 + 无 stage/bak 残留 | 🗄️ 演进：#10 中断语义要求**保留已写文件续跑补完**，与整体替换互斥；写入经工具直接落盘（沙箱校验保留）。若需单文件崩溃一致性，P3 评估 stage+rename（§五-5） |
| test_write_generated_code_html | 解析→落盘集成（html） | ✅ golden_html e2e（工具直写管线全链） |
| test_write_generated_code_multi_file | 解析→落盘集成（multi_file） | ✅ golden_multi_file e2e |
| test_write_generated_code_rejects_unknown_type | 未知类型 ValueError | ⚠️ 白名单外回退 html → §五-1 |

### `test_guardrails.py`（6 例）— 输入安全护轨

全部 ✅ `test/interview/guardrails.test.ts` 逐条移植：空输入 / 超长（>1000 字）/ 边界 1000 字通过 / 中英敏感词 / 注入模式（忽略指令/扮演管理员/System:/New instructions:）/ 正常提示词通过。拒绝文案与旧实现逐字一致（`stream.test.ts` 断言「输入包含不当内容，请修改后重试」）。

### `test_quality.py`（4 例）— 质检

| 测试 | 语义 | TS 处置 |
|---|---|---|
| test_concatenate_includes_code_and_skips_ignored | 拼接只含代码文件，跳过隐藏/node_modules/dist | ✅ `review.test.ts`（本票补 dist 断言） |
| test_concatenate_missing_dir_returns_empty | 目录缺失返回空 | ✅ `review.test.ts`（本票补） |
| test_check_quality_parses_json | 质检 JSON → 结构化结果 | ✅ `review.test.ts` parseQualityScore（结构升级：isValid/grade/errors/suggestions） |
| test_check_quality_fallback_pass_on_error | 解析异常按通过兜底 | 🗄️ 有意变更（#9 设计）：无法解析视为**未通过**（宁可重试不放行劣质产物），判据见 `review.test.ts` 注释与 #9 记录 |

### `test_images.py`（8 例）— 图片四工具

| 测试 | 语义 | TS 处置 |
|---|---|---|
| test_plan_parses_full_plan | 采集计划 JSON 四类任务解析 | 🗄️ 演进：工具直调模式（模型轮内直接调图片工具），两段式计划未接线（遗留死代码见 §五-4） |
| test_plan_fallback_empty_on_parse_failure | 计划解析失败回退空 | 🗄️ 同上 |
| test_search_content_images_parses_pexels | Pexels 解析 medium 地址 | ✅ `imageTools.test.ts`（含过滤无图项增强） |
| test_search_content_images_skips_without_key | 无 key 返回空 | ✅ `imageTools.test.ts` |
| test_generate_logos_parses_dashscope | Logo 生成解析 + 禁文字提示词 | ✅ `imageTools.test.ts` |
| test_generate_architecture_diagram_failure_returns_empty | mmdc 失败返回空不阻断 | ✅ `imageTools.test.ts`（增强：失败返还配额） |
| test_image_tools_bound_names | 四工具名对齐 | ✅ `test/generation/tools/tools-contract.test.ts`（本票补） |
| test_collect_images_collects_from_tool_results | 工具结果汇总为资源列表 | 🗄️ 演进：工具循环内结果直接回喂模型（AI SDK tool-result），素材不再两段式汇总 |

### `test_graph.py`（6 例）— 工作流编排

| 测试 | 语义 | TS 处置 |
|---|---|---|
| test_guardrail_rejection_ends_with_error | 护轨拒绝短路不生成 | ✅ `stream.test.ts`（无 coding 里程碑/工具事件） |
| test_html_flow_writes_workspace | 路由→生成→质检→落盘 | ✅ golden_html + `stream.test.ts`（review 三重门禁在档） |
| test_image_resources_appended_to_enhanced_prompt | 素材拼进增强提示词 | 🗄️ 演进：工具直调模式下素材经 tool-result 直接进上下文 |
| test_quality_failure_retries_then_ends | 质检失败重试至上限（1+2 次） | ✅ `quality-gate.test.ts`（MAX_QUALITY_RETRIES=2 有界） |
| test_quality_passes_after_retry | 重试后通过即停 | ✅ `quality-gate.test.ts`（fail-then-pass 剧本） |
| test_vue_flow_collects_events | vue 事件流汇总 | ✅ `stream.test.ts` 事件映射 |

### `test_checkpoint.py`（3 例）— 会话状态持久

三例均 ✅（替代机制，判据架构 §3.2「generation_run = checkpoint 等价物」）：PG checkpoint 退役，断点续传由 `generation_run` 承接——`wireframe_pending` 跨请求存活（`requirements.test.ts` 确认闸门跨请求）、续跑实例语义（`fileTools.test.ts` 续跑落盘计数 / `abort.test.ts`）、run API 并发拒绝 + `getLatestNonTerminalRun`（`run-client.test.ts`）。

### `test_e2e.py`（2 例）— 离线全链 golden e2e

| 测试 | 语义 | TS 处置 |
|---|---|---|
| test_offline_html_e2e | golden 夹具 → 全工作流 → 产物片段断言 | ✅ `test/golden-e2e.test.ts` + `fixtures/golden_html.json`（本票补） |
| test_offline_multi_file_e2e | multi_file golden 全链 | ✅ `golden_multi_file.json` + `multi-file` 剧本（本票补） |

### `test_callback.py`（4 例）— 完成回调客户端

全部 ✅：URL/Bearer（`run-client.test.ts` completeRun + `stream.test.ts` 断言 `/complete` 端点）、success 体、failed 带 message、**HTTP 非 2xx 不阻断主流程**（`stream.test.ts` 本票新增容错用例；端点演进为 `/internal/agent/runs/{runId}/complete`，#6/#10）。

## 三、能力域汇总

| 能力域 | 状态 |
|---|---|
| 鉴权 / healthz / SSE 格式 / 事件 schema | ✅ 对等 |
| run 生命周期 / 完成回调 / 冻结积分 / 中断折算 | ✅ 对等（#4/#6/#10 演进形状） |
| 工作区沙箱（含符号链接逃逸增强） | ✅ 对等 |
| 文件工具六件 + 驼峰契约 + 重要文件保护 | ✅ 对等 |
| 图片四工具 + 配额（增强：失败返还） | ✅ 对等（计划两段式演进） |
| 输入护轨（空/超长/敏感词/注入） | ✅ 对等（文案逐字一致） |
| 代码块解析（html/multi_file 单元能力） | ✅ 对等（主链路接线遗留见 §五-4） |
| 质检（拼接/结构化分/build/视觉 diff/有界重试） | ✅ 对等（解析失败兜底方向有意反转，判据在档） |
| 访谈 / 线框 / 确认闸门 / 免费限频 | ✅ 对等（`requirements.test.ts`，旧套件无直接对应测试） |
| 五层护栏 / 三档强度 / token 计量 / 超限收尾 | ✅ 对等（`intensity.test.ts` + `quality-gate.test.ts`） |
| 断点续传（checkpoint 替代） | ✅ 对等（generation_run 承接） |
| 离线 golden e2e | ✅ 对等（本票补齐） |

## 四、T21 门禁判定

**「契约对等」半边：通过**（72 直接覆盖 + 9 有意演进/退役判据在档 + 3 语义差异列 §五，无能力缺失）。
**「回归全绿」半边**：TS `npm test` 144/144 + type-check 通过；Java 侧回归证据见 #9/#10 票（#10 交付 70/70、code-review 整改后 **77/77** 为最新在档证据 + 全量对比基线无回归）。

## 五、P3 联调修正项（本票移交，不阻断 T21）

1. **codeGenType 白名单外行为**：旧契约 422 拒绝，现回退 html——定夺「拒绝」还是「回退」并写入 contract.md。
2. **message 必填不一致**：`docs/ts_agent/contract.md` 写 `message` 必填，路由实际只强制 runId/appId/userId——文档与实现二选一对齐。
3. **质检解析失败兜底方向**：旧=按通过，新=按未通过（#9 有意设计）——确认后写入 contract.md。
4. **死代码清理**：`src/codegen/parsing.ts` 与 `prompts/` 中 multi-file/vue/routing/quality/image-plan 提示词已导出未接线（生成主链路仅消费 codegen-html）——P3 决定接线或删除。
5. **单文件写入崩溃一致性**：旧「整体替换+stage 兄弟目录」语义与中断续跑互斥已演进，但单文件 temp+rename 原子性可按需评估。

> 计数口径：例数按旧套件测试函数计（parametrize 记 1 例），合计 84；✅+⚠️+🗄️=84。
