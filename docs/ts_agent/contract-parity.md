# TS Agent 契约对等报告（Issue #11）

> 用途：T21 门禁「TS Agent 契约对等」半边的判据（架构 §退役方案第 2 条）。
> 对账对象：旧 Python Agent 测试套件 `paimeng-ai-code-rag/tests/`（13 文件 / 84 例，与 Issue #11 票面一致）。
> 对等口径：**语义比对，不比对字节**；「有意退役/演进」项须引用 `docs/ts_agent/architecture.md` 判据，不记为实现缺口。
> 结论日期：2026-09-07。

## 一、结论：对等未达成（T21 判据不通过）

| 处置 | 例数 | 说明 |
|---|---|---|
| ✅ 已覆盖 | 22 | 语义等价，TS 侧有测试在档 |
| ⚠️ 部分覆盖 | 11 | 核心语义在，关键能力面缺失 |
| 🗄️ 有意退役/演进 | 3 | 架构决策转移职责，判据见逐项标注 |
| ❌ 缺口 | 48 | 需补齐移植（P2 能力未落地） |

**根因（比缺口本身更重要）**：Issue #7、#8、#9、#10、#12 已关闭，但其声称的实现**不存在于任何可核查位置**——P2 核心能力整体未实施。本仓库基线停在 #6 收口态（TS 37/37）。

### 幻影关闭核查证据（2026-09-07 实查）

1. **commit 不存在**：各票关闭评论声称的提交（#8 `2aee349`、#9 `10b9a97`、#10 `fb63148`/`25cb132`/`707bf5d`/`23dd7d8`）在本地 `git cat-file`、`origin` 远端、GitHub API（`repos/.../commits/2aee349` → 422 No commit found）三处均不存在。
2. **测试基线不符**：`paimeng-ai-code-agent/` 实测 `npm test` **37/37**（#6 收口值）；各票声称的 50/50、85/85、128/128、137/137 均无法复现。
3. **代码缺席**：`src/` 无访谈/线框/工具四件/解析/护栏/质检/图片/强度/计量/积分/中断任何模块；`paimeng-ai-code-agent/src` 全部文件 mtime = 2026-09-06 01:13:39（clone 时刻，clone 后从未被改写）；本机无其他工作副本。
4. **文档断链**：`docs/ts_agent/progress.md` 无 #7-#10 条目（#7 关闭评论声称「详见 progress.md #7 完成」，实查不存在）；`docs/ts_agent/contract.md` 无 #9 评论声称的「硬上限与超限收尾」段落；`MEMORY.md` 与 `.agents/memories/ts-agent.md` 停留在「#7-#9 为下一步」——跨会话记忆从未记录过这些票完成，与仓库实态一致。
5. **前端同样悬空**：#12 声称 fetch-SSE/JWT/新事件渲染已落地，`paimeng-ai-code-mother-frontend/src` 无任何 `/agent/stream`/JWT 消费代码，前端最后一次实质提交仍是运行时环境整改。

时间线佐证：本 clone 建于 2026-09-06 01:13，#7-#10 关闭于 2026-09-04/05——若实现曾推送到 GitHub，clone 必然包含；GitHub 无，故实现从未存在于共享历史。

## 二、逐文件清点表（84 例）

处置标记：✅ 已覆盖 / ⚠️ 部分 / 🗄️ 退役·演进 / ❌ 缺口。

### `test_contract.py`（11 例）— Java↔Agent 内部契约

| 测试 | 语义 | TS 处置 |
|---|---|---|
| test_healthz | /healthz 200 且 `{"status":"ok"}` | ✅ `test/healthz.test.ts` |
| test_stream_requires_auth | 无 Authorization → 401 | ✅ `test/auth.test.ts` 401 矩阵 |
| test_stream_with_wrong_token | 错误令牌 → 401 | ✅ `test/auth.test.ts` |
| test_stream_with_valid_token | 合法令牌 → 200 + text/event-stream + data: | ✅ `test/stream.test.ts` |
| test_stream_rejects_path_traversal | workspacePath 越界 → 拒绝 | ✅ `test/workspace.test.ts`（validate 400）+ `stream.test.ts`（流内 error 终态不写文件） |
| test_stream_rejects_relative_path | 相对路径 → 拒绝 | ✅ `test/workspace.test.ts`（流内经 sandbox 拒绝，语义等价） |
| test_stream_rejects_invalid_code_gen_type | codeGenType 白名单校验 | 🗄️ 生成类型路由归 Java（架构 §退役：`createApp` 保留 Java 侧 AI 路由决策）；TS 新契约未定义该字段 |
| test_stream_rejects_empty_message | message 空 → 拒绝 | ✅ `routes/agent.ts` 必填校验（旧 422 / 新 400，契约变更已定稿于 contract.md） |
| test_event_schema_aligns_with_java | ai_response/tool_request 事件字段逐字段 | ✅ `src/events.ts` + `test/stream.test.ts` 字段断言 |
| test_callback_schema_alignment | 回调体逐字段 + status 枚举 | ✅ #6 `completeRun`（`test/stream.test.ts` 断言 success/failed + messages + workspacePath；回调形状按 #6 演进为写历史+构建） |
| test_healthz_does_not_require_auth | 健康检查免鉴权 | ✅ `test/healthz.test.ts` |

### `test_sse.py`（3 例）— SSE 序列化约定

| 测试 | 语义 | TS 处置 |
|---|---|---|
| test_format_data_splits_newlines | 换行逐行拆 data: + 空行收尾 | ✅ `test/sse-format.test.ts` |
| test_format_event_with_event_field | event 行先于 data 行 | ✅ `test/sse-format.test.ts` |
| test_encode_stream_message_is_single_data_line | 结构化事件单行 JSON | ✅ `test/sse-format.test.ts` |

### `test_streaming.py`（8 例）— 流式输出适配

| 测试 | 语义 | TS 处置 |
|---|---|---|
| test_html_stream_yields_text_and_writes_workspace | html 文本块流出 + 解析落盘 index.html | ⚠️ 事件流与落盘 ✅（`stream.test.ts`）；` ```html ` 代码块解析语义 ❌（TS 假 LLM 全文直写） |
| test_multi_file_stream_writes_three_files | multi_file 三文件解析落盘 | ❌ 无 multi_file 模式与解析 |
| test_vue_stream_emits_structured_events | vue_project 结构化事件归一化 | ⚠️ 事件映射 ✅（tool_request/tool_executed/ai_thinking/ai_response，`stream.test.ts`）；vue_project 模式 ❌ |
| test_guardrail_rejection_emits_error_event | 输入护轨拒绝 → error 且无业务事件 | ❌ 无输入护轨（P2） |
| test_generation_exception_emits_error_event | 生成异常 → error 事件 | ✅ `stream.test.ts` error 剧本 |
| test_success_callback_fired_after_workspace_write | 落盘后 success 回调 | ✅ `stream.test.ts`（终态前回调 + workspacePath） |
| test_failed_callback_fired_on_generation_error | 异常 → failed 回调带 message | ✅ `stream.test.ts`（errorMessage） |
| test_failed_callback_on_guardrail_rejection | 护轨拒绝 → failed 回调 | ❌ 无护轨 |

### `test_codegen.py`（11 例）— 解析 / 路由 / 工厂 / vue 工具

| 测试 | 语义 | TS 处置 |
|---|---|---|
| test_parse_html_code_extracts_block | 提取 ```html 块 | ❌（架构仍列「代码解析」为 TS 职责 → 实现缺口） |
| test_parse_html_code_fallback_to_whole | 无块时全文兜底 | ❌ |
| test_parse_multi_file_extracts_three_blocks | html/css/js 三块解析 | ❌ |
| test_parse_multi_file_missing_css | 缺块时空串 | ❌ |
| test_to_files_html | 解析结果 → {index.html} | ❌ |
| test_to_files_multi_file_skips_blank | 空白内容不写文件 | ❌ |
| test_route_code_gen_type | 模型回复路由生成类型 | 🗄️ 路由归 Java（架构 §退役 `createApp` 保留 Java 路由决策） |
| test_factory_creates_by_type | 按类型工厂创建服务 | 🗄️ 旧抽象随文本流模式退役，由 XState coding 工位承接 |
| test_executor_stream_html_multi_file_uses_text_stream | 按类型分发文本流服务 | ⚠️ 分发语义由 workflow 承接；文本流模式本身待随解析补齐 |
| test_vue_tools_binding | 六文件工具绑定（writeFile/readFile/modifyFile/deleteFile/readDir/exit） | ❌ TS 仅有 writeFile（无 content 参数，语义不同） |
| test_vue_execute_dispatches | 工具名分发 + 中文结果文案 | ❌ |

### `test_tools.py`（11 例）— 文件工具行为

| 测试 | 语义 | TS 处置 |
|---|---|---|
| test_write_file_creates_parent_dirs | 写文件自动建父目录 | ❌（TS writeFile 行为不同：内容由文本流闭包注入） |
| test_read_file_roundtrip | 读往返一致 | ❌ |
| test_read_file_missing_returns_error | 读缺失返回错误文案 | ❌ |
| test_modify_file_replaces_content | oldContent→newContent 替换 | ❌ |
| test_modify_file_missing_old_content | 旧内容缺失警告且不改 | ❌ |
| test_delete_file | 删除文件 | ❌ |
| test_delete_important_file_rejected | 重要文件（package.json）保护 | ❌ |
| test_exit_tool | exit 终止提示词 | ❌ |
| test_read_dir_structure | 目录结构读取、忽略构建产物 | ❌ |
| test_path_traversal_rejected | 相对路径 `..` 越界拒绝 | ⚠️ 沙箱层 ✅（`workspace.test.ts`）；工具层参数校验 ❌ |
| test_absolute_path_outside_rejected | 绝对路径越界拒绝 | ⚠️ 同上 |

> 工具名/参数键驼峰契约（Java `ToolManager` 依赖）在旧套件中由本文件与 test_codegen 覆盖——TS 补齐时必须保持（`ts-agent.md` 移植要点）。

### `test_workspace.py`（7 例）— 沙箱与原子写入

| 测试 | 语义 | TS 处置 |
|---|---|---|
| test_validate_accepts_path_under_root | 根下路径通过 | ✅ `test/workspace.test.ts` |
| test_validate_rejects_relative_path | 相对路径拒绝 | ✅ |
| test_validate_rejects_path_outside_root | 越界拒绝 | ✅ |
| test_atomic_write_replaces_workspace | 文件集整体替换 + 无 .stage/.bak 残留 | ❌ TS 直接 writeFile，无原子替换（移植要点：stage 必须建于目标父目录） |
| test_write_generated_code_html | 解析+落盘集成（html） | ❌ |
| test_write_generated_code_multi_file | 解析+落盘集成（multi_file） | ❌ |
| test_write_generated_code_rejects_unknown_type | 未知类型 ValueError | ❌ |

### `test_guardrails.py`（6 例）— 输入安全护轨（P2）

| 测试 | 语义 | TS 处置 |
|---|---|---|
| test_empty_input_rejected | 空输入拒绝（「输入内容不能为空」） | ❌ |
| test_overlong_input_rejected | >1000 字拒绝 | ❌ |
| test_boundary_length_allowed | 恰 1000 字通过 | ❌ |
| test_sensitive_word_rejected | 中英敏感词拒绝 | ❌ |
| test_injection_pattern_rejected | 注入模式（忽略指令/扮演管理员等）拒绝 | ❌ |
| test_normal_prompt_allowed | 正常提示词通过 | ❌ |

### `test_quality.py`（4 例）— 质检（P2）

| 测试 | 语义 | TS 处置 |
|---|---|---|
| test_concatenate_includes_code_and_skips_ignored | 拼接只含代码文件，跳过隐藏/node_modules/dist | ❌ |
| test_concatenate_missing_dir_returns_empty | 目录缺失返回空 | ❌ |
| test_check_quality_parses_json | 质检 JSON → QualityResult | ❌（TS 仅有 `<html` includes 最小检查） |
| test_check_quality_fallback_pass_on_error | 质检异常按通过兜底 | ❌ |

### `test_images.py`（8 例）— 图片四工具（P2）

| 测试 | 语义 | TS 处置 |
|---|---|---|
| test_plan_parses_full_plan | 采集计划 JSON 解析（内容/插画/图表/Logo 四类任务） | ❌ |
| test_plan_fallback_empty_on_parse_failure | 解析失败回退空计划 | ❌ |
| test_search_content_images_parses_pexels | Pexels 搜索解析 medium 地址 | ❌ |
| test_search_content_images_skips_without_key | 无 key 返回空 | ❌ |
| test_generate_logos_parses_dashscope | Logo 生成解析 + 禁文字提示词 | ❌ |
| test_generate_architecture_diagram_failure_returns_empty | mmdc 失败返回空不阻断 | ❌ |
| test_image_tools_bound_names | 四工具名对齐（searchContentImages 等） | ❌ |
| test_collect_images_collects_from_tool_results | 工具结果汇总为 ImageResource | ❌ |

### `test_graph.py`（6 例）— 工作流编排

| 测试 | 语义 | TS 处置 |
|---|---|---|
| test_guardrail_rejection_ends_with_error | 护轨拒绝短路，不执行生成 | ❌ |
| test_html_flow_writes_workspace | 路由→生成→质检→落盘全流程 | ⚠️ 落盘链 ✅（`stream.test.ts`）；质检节点 ❌ |
| test_image_resources_appended_to_enhanced_prompt | 图片素材拼进增强提示词 | ❌ |
| test_quality_failure_retries_then_ends | 质检失败重试至上限（1+2 次） | ❌ |
| test_quality_passes_after_retry | 重试后通过即停 | ❌ |
| test_vue_flow_collects_events | vue 事件流汇总 | ⚠️ 事件映射在；vue 模式不在 |

### `test_checkpoint.py`（3 例）— 会话状态持久（PG checkpoint）

| 测试 | 语义 | TS 处置 |
|---|---|---|
| test_first_use_no_checkpoint | 首次无 checkpoint → bootstrap history | ⚠️ 架构演进：PG checkpoint 退役，等价物为 `generation_run` 断点续传（架构 §3.2）。run API + `getLatestNonTerminalRun` 客户端 ✅；「从 phase 续跑 / wireframe_pending 跨请求」行为 ❌（随 #7 重做） |
| test_checkpoint_persists_and_restores | 同 thread 二次请求恢复 | ⚠️ 同上 |
| test_threads_are_isolated | thread 相互隔离 | ⚠️ 同上（run 按 appId/userId 隔离语义在 API 层 ✅） |

### `test_e2e.py`（2 例）— 离线全链 golden e2e

| 测试 | 语义 | TS 处置 |
|---|---|---|
| test_offline_html_e2e | golden 夹具 → 全工作流 → 工作区片段断言 | ❌ 待 P2 能力落位后随本票补（当前 stream.test 已覆盖单文件最小链） |
| test_offline_multi_file_e2e | multi_file golden 全链 | ❌ 同上 |

### `test_callback.py`（4 例）— 完成回调客户端

| 测试 | 语义 | TS 处置 |
|---|---|---|
| test_build_callback_url | 回调 URL 拼接 | ✅ #6（端点演进为 `/internal/agent/runs/{runId}/complete`，`stream.test.ts` 断言） |
| test_send_callback_success | success 体 + Bearer 头 | ✅ `stream.test.ts` |
| test_send_callback_failed_carries_message | failed 带 message | ✅ `stream.test.ts`（errorMessage） |
| test_send_callback_http_error_returns_false | Java 非 2xx 不抛出 | ⚠️ `notifyComplete` 容错实现已存在（失败不阻断），无直接测试断言 |

## 三、能力域汇总（对账 → 票据映射）

| 能力域 | 对账状态 | 对应票据 |
|---|---|---|
| 鉴权 / healthz / SSE 格式 / 事件 schema | ✅ 对等 | #3/#5（真实完成） |
| run 生命周期 / 完成回调 / 回退链路 | ✅ 对等 | #4/#6（真实完成） |
| 工作区沙箱校验 | ✅ 对等（工具层参数校验随工具四件补） | #3 |
| 代码解析（html/multi_file）+ 落盘管线 + 原子写入 | ❌ 缺口 | #8（幻影关闭，需重做） |
| 文件工具六件 + 重要文件保护 + exit | ❌ 缺口 | #8 |
| 输入护轨（空/超长/敏感词/注入） | ❌ 缺口 | #9 |
| 质检（拼接/JSON 解析/异常兜底/重试上限） | ❌ 缺口 | #9 |
| 图片四工具 + 采集计划 | ❌ 缺口 | #8/#9 |
| 访谈 + 线框 + 确认闸门 + 免费限频 | ❌ 缺口（旧套件无直接对应测试，验收在 e2e 剧本） | #7 |
| 五层护栏 / 三档强度 / token 计量 / 超限收尾 | ❌ 缺口 | #9 |
| 积分冻结/结算/退款 + 对话中断 | ❌ 缺口 | #10 |
| 断点续传（checkpoint 等价） | ⚠️ API 层在，续跑行为缺 | #7 |
| 离线 golden e2e | ❌ 缺口 | #11 本票（P2 落位后） |
| 前端 fetch-SSE/JWT/新事件渲染 | ❌ 缺口 | #12（幻影关闭，需重做） |

## 四、T21 门禁判定

**不通过**。「契约对等 + 回归全绿」两半均未达成：84 例旧套件语义对等 22 例（26%）、部分覆盖 11 例；回归基线为 #6 收口态 37/37，而非各票声称的 137/137。T21（灰度切换 + 删旧 Java AI）的前置条件是 P2（#7-#9）与计费（#10）、前端通道（#12）真实落地后重跑本对账。

## 五、计数口径备注

- 例数按旧套件测试函数计（parametrize 的 `test_route_code_gen_type` 记 1 例）；与 Issue #11 票面「84 测试（13 文件）」一致。
- ✅ 的判定标准：TS 侧存在覆盖同一语义的测试（允许状态码/字段名等已定稿的契约变更，变更须在 contract.md 有档）。
- 🗄️ 判定必须引用 architecture.md 条文，禁止用于粉饰实现缺口。
