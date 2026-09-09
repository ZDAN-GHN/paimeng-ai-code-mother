// 脚本化假 LLM：以 Vercel AI SDK 的 LanguageModelV2 接口实现的离线 provider（零在线调用，Issue #5）。
// 经 customProvider 注册为 `scripted` 系列模型，由 streamText / generateText 消费——模型交互整体走 AI SDK
// provider 抽象，后续替换真实 provider 时只换 provider 工厂、不动工作流。
// #9 扩展：① 三档模型（scripted-fast/standard/deep，对应三档推理强度，供路由断言）；
// ② 质检模型 scripted-quality（reviewer 工位结构化质检分，返回 code-quality-check JSON）；
// ③ 超限剧本 limit（工具调用无休止，触发 max_tool_calls/max_turns 上限验证优雅收尾）；
// ④ 调用记录 records（modelId + maxOutputTokens + prompt 角色，断言路由与档位上限随动）。

import { customProvider } from 'ai'
import type { LanguageModelV2, LanguageModelV2CallOptions, LanguageModelV2StreamPart } from '@ai-sdk/provider'

export type LlmScript =
  // 成功剧本：一轮文本 + writeFile 工具 + 收尾文本（契约成功路径）
  | 'success'
  // 模型层失败剧本：一进流式即抛错（工作流 catch → failed 终态）
  | 'error'
  // 图片配额剧本：一轮内并行多次图片搜索（第 2 次触发配额拒绝）
  | 'images'
  // 多文件剧本：一轮内并行写 index.html/style.css/script.js 三文件（golden e2e 用，对齐旧 golden_multi_file 夹具）
  | 'multi-file'
  // 质检失败-重试后通过：第 1 次质检 isValid:false（触发 RETRY），第 2 次起 isValid:true（重试后通过）
  | 'quality-fail-then-pass'
  // 质检永远失败：每次质检 isValid:false（重试耗尽 → failed 终态）
  | 'quality-fail-always'
  // 超限剧本：工具调用无休止（触发 max_tool_calls / max_turns 上限，验证优雅收尾）
  | 'limit'
  // 输出长度截断剧本：finishReason='length'（模拟达 max_output_tokens 被 provider 截断，验证 length 路径优雅收尾）
  | 'limit-length'

// 单次模型调用记录（测试断言：路由到哪个模型 id、收到什么上限、prompt 是否含工具结果）
export interface ScriptedCallRecord {
  modelId: string
  maxOutputTokens: number | undefined
  hasToolResult: boolean
}

// 用户消息 → 页面内容（评审内容即 ai_response 增量文本的拼接）
// 产物含应用内导览组件（onboarding tour，Issue #8 验收「生成产物包含应用内导览组件」）。
// #9：产物带页面区段骨架（section id="page-N"，对齐线框结构）——视觉 diff 门禁以已确认线框为基准
// 对比页面区段，假 LLM 产物须含可比的骨架，默认门禁才被真实执行而非空转。
// #13 L1 预览态：产物内置 MSW 风格 mock 拦截层（fetch/XHR 打补丁 + fixture 规则表），
// 页面自带列表加载与表单提交演示——预览 iframe 中应用交互全可演示（架构 §L1，MVP）。
export function buildPageContent(message: string): string {
  const title = message.trim() || 'generated page'
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  #onboarding-tour{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)}
  .tour-panel{background:#fff;border-radius:8px;padding:24px;max-width:320px;box-shadow:0 4px 20px rgba(0,0,0,.2)}
  .tour-actions{display:flex;justify-content:space-between;margin-top:16px}
  button{cursor:pointer;border:none;border-radius:4px;padding:6px 12px}
  .tour-next{background:#4f6ef7;color:#fff}
  .tour-skip{background:transparent;color:#666}
  section.page{border:1px solid #eee;padding:16px;margin:8px 0}
  .mock-list{list-style:none;padding:0}
  .mock-list li{padding:6px 8px;border-bottom:1px dashed #e5e5e5}
  .mock-form{display:flex;gap:8px;margin-top:10px}
  .mock-form input{flex:1;padding:6px 8px;border:1px solid #ddd;border-radius:4px}
  .mock-form button{background:#4f6ef7;color:#fff}
  .mock-status{font-size:12px;color:#999;margin-top:6px}
</style>
<script>
  // MSW 风格 mock 后端（L1 预览态，fixture 先行）：拦截 fetch/XHR 命中规则表返回 fixture，
  // 未命中放行真实网络——预览 iframe 中列表加载/表单提交全可演示，无需真实后端。
  (function () {
    // fixture 规则表：method + url 匹配 → 响应载荷
    var FIXTURES = {
      'GET /api/items': { code: 0, data: [
        { id: 'mock-1', title: '示例条目一', desc: 'mock fixture 数据' },
        { id: 'mock-2', title: '示例条目二', desc: '预览态可演示' },
        { id: 'mock-3', title: '示例条目三', desc: '表单提交后追加' }
      ] },
      'POST /api/items': { code: 0, data: { id: 'mock-new', created: true } }
    };
    function matchFixture(method, url) {
      var path = String(url).replace(/^https?:\\/\\/[^/]+/, '');
      return FIXTURES[method + ' ' + path] || FIXTURES[method + ' ' + path.split('?')[0]];
    }
    function fixtureResponse(matched, requestBody) {
      // POST 回显请求体（演示表单提交内容进入响应）
      if (requestBody && matched === FIXTURES['POST /api/items']) {
        try {
          var parsed = JSON.parse(requestBody);
          return { code: 0, data: { id: 'mock-new', created: true, echo: parsed } };
        } catch (e) { /* 非 JSON 体按默认 fixture 返回 */ }
      }
      return matched;
    }
    // fetch 打补丁：命中规则返回合成 Response
    var originalFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var matched = matchFixture(method, url);
      if (!matched || !originalFetch) {
        return originalFetch ? originalFetch.apply(window, arguments) : Promise.reject(new Error('fetch blocked'));
      }
      return Promise.resolve(new Response(JSON.stringify(fixtureResponse(matched, init && init.body)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }));
    };
    // XHR 打补丁：同步拦截 send，命中规则回 fixture
    var OriginalXHR = window.XMLHttpRequest;
    function MockXHR() {
      var xhr = new OriginalXHR();
      var mocked = null;
      var originalOpen = xhr.open;
      xhr.open = function (method, url) {
        mocked = matchFixture(String(method).toUpperCase(), url);
        return originalOpen.apply(xhr, arguments);
      };
      xhr.send = function (body) {
        if (!mocked) return originalOpen.apply(xhr, arguments);
        Object.defineProperty(xhr, 'status', { value: 200 });
        Object.defineProperty(xhr, 'readyState', { value: 4 });
        Object.defineProperty(xhr, 'responseText', { value: JSON.stringify(fixtureResponse(mocked, body)) });
        if (typeof xhr.onreadystatechange === 'function') xhr.onreadystatechange();
        if (typeof xhr.onload === 'function') xhr.onload();
      };
      return xhr;
    }
    MockXHR.prototype = OriginalXHR.prototype;
    window.XMLHttpRequest = MockXHR;
  })();
</script>
</head>
<body>
<h1>${title}</h1>
<p>generated by scripted fake llm</p>
<!-- 页面区段骨架（#9 视觉 diff 基准对比对象）：单页骨架 page-0，供默认视觉 diff 门禁比对 -->
<section class="page" id="page-0"><h2>首页</h2><p>${title} 的内容概览</p>
  <ul class="mock-list" id="mock-items"></ul>
  <form class="mock-form" id="mock-form">
    <input type="text" id="mock-input" placeholder="输入新条目标题" />
    <button type="submit">添加</button>
  </form>
  <p class="mock-status" id="mock-status">列表经 mock 拦截层加载</p>
</section>
<!-- 应用内导览组件：新用户引导，覆盖关键区块，可主动关闭 -->
<div id="onboarding-tour" role="dialog" aria-label="新手引导">
  <div class="tour-panel" data-step="1"><p>欢迎使用 ${title}，这是首页概览。</p><div class="tour-actions"><button class="tour-skip">跳过</button><button class="tour-next">下一步</button></div></div>
  <div class="tour-panel" data-step="2"><p>这是核心功能入口，点击即可开始使用。</p><div class="tour-actions"><button class="tour-skip">跳过</button><button class="tour-next">完成</button></div></div>
</div>
<script>
  // 导览组件逻辑：步骤切换与关闭（应用内组件，非独立文档）
  (function () {
    var tour = document.getElementById('onboarding-tour');
    var panels = tour.querySelectorAll('.tour-panel');
    var idx = 0;
    function show(i) { panels.forEach(function (p, k) { p.style.display = k === i ? 'block' : 'none'; }); }
    function close() { tour.style.display = 'none'; }
    show(0);
    panels.forEach(function (p) {
      p.querySelector('.tour-next').addEventListener('click', function () {
        idx += 1;
        if (idx >= panels.length) close(); else show(idx);
      });
    });
    tour.querySelectorAll('.tour-skip').forEach(function (b) { b.addEventListener('click', close); });
  })();
  // 列表加载与表单提交演示：请求全部经 mock 拦截层命中 fixture（L1 预览态可交互）
  (function () {
    var list = document.getElementById('mock-items');
    var status = document.getElementById('mock-status');
    function renderItem(item) {
      var li = document.createElement('li');
      li.textContent = item.title + (item.desc ? ' —— ' + item.desc : '');
      list.appendChild(li);
    }
    // 列表加载（GET /api/items → fixture）
    fetch('/api/items').then(function (res) { return res.json(); }).then(function (json) {
      (json.data || []).forEach(renderItem);
      status.textContent = '已加载 ' + (json.data || []).length + ' 条 mock 数据';
    }).catch(function () {
      status.textContent = '列表加载失败';
    });
    // 表单提交（POST /api/items → fixture 回显，成功后追加列表）
    document.getElementById('mock-form').addEventListener('submit', function (event) {
      event.preventDefault();
      var input = document.getElementById('mock-input');
      var title = input.value.trim();
      if (!title) return;
      fetch('/api/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title })
      }).then(function (res) { return res.json(); }).then(function (json) {
        renderItem({ title: title, desc: json.data && json.data.created ? '已创建（mock 回显）' : '' });
        input.value = '';
        status.textContent = '提交成功：' + title;
      }).catch(function () {
        status.textContent = '提交失败';
      });
    });
  })();
</script>
</body>
</html>
`
}

// 工具调用 id（契约要求 tool_request 与对应 tool_executed 同 id；假模型每轮固定调用）
const WRITE_FILE_TOOL_CALL_ID = 'write-file-1'
const IMAGE_SEARCH_TOOL_CALL_IDS = ['image-search-1', 'image-search-2']
// 多文件剧本的固定产物（对齐旧 golden_multi_file 夹具断言片段，test/fixtures/golden_multi_file.json 同源）
const MULTI_FILE_CONTENTS: Array<{ relativeFilePath: string; content: string }> = [
  {
    relativeFilePath: 'index.html',
    content: '<!DOCTYPE html>\n<html>\n<head><title>多文件页面</title></head>\n<body>\n<div id="app">多文件应用</div>\n</body>\n</html>',
  },
  {
    relativeFilePath: 'style.css',
    content: 'body { margin: 0; }\n#app { color: red; }',
  },
  {
    relativeFilePath: 'script.js',
    content: "const app = document.getElementById('app');\napp.addEventListener('click', () => alert('ok'));",
  },
]

// 把预置 part 序列封成 ReadableStream（SDK 按序消费）
function streamFromParts(parts: LanguageModelV2StreamPart[]): ReadableStream<LanguageModelV2StreamPart> {
  return new ReadableStream<LanguageModelV2StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part)
      controller.close()
    },
  })
}

// 假模型公共行为：prompt 工具结果判定与最近用户文本提取
function hasToolResult(options: LanguageModelV2CallOptions): boolean {
  return options.prompt.some((message) => message.role === 'tool')
}

function lastUserText(options: LanguageModelV2CallOptions): string {
  for (let i = options.prompt.length - 1; i >= 0; i--) {
    const message = options.prompt[i]
    if (message?.role === 'user') {
      const text = message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')
      if (text) return text
    }
  }
  return ''
}

// codegen 假模型（三档共用同一实现，modelId 区分路由）
class ScriptedLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const
  readonly provider = 'scripted'
  readonly modelId: string
  readonly supportedUrls = {}

  constructor(
    private readonly script: LlmScript,
    modelId: string,
    private readonly records: ScriptedCallRecord[],
  ) {
    this.modelId = modelId
  }

  // 非流式路径（当前工作流 codegen 只走 streamText；doGenerate 供接口完整性与收尾调用）
  async doGenerate(options: LanguageModelV2CallOptions) {
    this.record(options)
    // 收尾调用（优雅收尾注入收尾指令后）：输出用户可见的完整交代
    const wrapUp = this.script === 'limit' || this.script === 'limit-length'
      ? '\n已达本次生成硬上限，以上为已生成的页面内容。\n'
      : '\n页面已写入 index.html\n'
    return {
      content: [{ type: 'text' as const, text: buildPageContent(lastUserText(options)) + wrapUp }],
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }
  }

  private record(options: LanguageModelV2CallOptions): void {
    this.records.push({
      modelId: this.modelId,
      maxOutputTokens: options.maxOutputTokens,
      hasToolResult: hasToolResult(options),
    })
  }

  async doStream(options: LanguageModelV2CallOptions) {
    this.record(options)
    if (this.script === 'error') {
      // error 剧本：模型一进流式即失败（工作流 catch 后走 failed 终态，error 后不再发业务事件）
      throw new Error('假 LLM 剧本故意失败')
    }
    if (this.script === 'limit' || this.script === 'limit-length') {
      // 超限剧本（limit）：工具调用无休止（每次都不带工具结果则继续调用工具，永不自然收尾）——
      // 直到工作流侧 max_tool_calls / max_turns 上限截断（stopWhen）后注入收尾指令走 doGenerate。
      // 带/不带工具结果两分支仅 delta 文本不同，合并构造（审查整改 Duplicated Code）。
      // 输出长度截断剧本（limit-length）：单轮输出后直接 finishReason='length'（模拟达 max_output_tokens 被截断），
      // 工作流对 'length' 与 'tool-calls' 一视同仁触发优雅收尾（审查整改 c4 覆盖该分支）。
      if (!hasToolResult(options) || this.script === 'limit-length') {
        const parts: LanguageModelV2StreamPart[] = [
          { type: 'text-start', id: 'page' },
          { type: 'text-delta', id: 'page', delta: '正在生成页面' },
          { type: 'text-end', id: 'page' },
        ]
        if (this.script === 'limit-length') {
          // 输出长度截断：不再发起工具调用，直接以 length 结束本轮（模拟输出上限截断）
          parts.push({ type: 'finish', finishReason: 'length', usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } })
        } else {
          parts.push(
            {
              type: 'tool-call',
              toolCallId: `limit-${this.records.length}`,
              toolName: 'writeFile',
              input: JSON.stringify({ relativeFilePath: 'index.html', content: buildPageContent(lastUserText(options)) }),
            },
            { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } },
          )
        }
        return { stream: streamFromParts(parts) }
      }
      // 带工具结果仍继续调用（无休止循环，由 stopWhen 截断）
      const parts: LanguageModelV2StreamPart[] = [
        { type: 'text-start', id: 'again' },
        { type: 'text-delta', id: 'again', delta: '继续生成' },
        { type: 'text-end', id: 'again' },
        {
          type: 'tool-call',
          toolCallId: `limit-${this.records.length}`,
          toolName: 'writeFile',
          input: JSON.stringify({ relativeFilePath: 'index.html', content: buildPageContent(lastUserText(options)) }),
        },
        { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } },
      ]
      return { stream: streamFromParts(parts) }
    }
    const content = buildPageContent(lastUserText(options))
    if (!hasToolResult(options)) {
      // 第一轮：流式页面内容（供 ai_response）+ 工具调用（供 tool_request/tool_executed）
      const parts: LanguageModelV2StreamPart[] = [
        { type: 'text-start', id: 'page' },
        // 拆两块模拟增量流式，契约定 ai_response 按增量块推送
        { type: 'text-delta', id: 'page', delta: content.slice(0, 32) },
        { type: 'text-delta', id: 'page', delta: content.slice(32) },
        { type: 'text-end', id: 'page' },
      ]
      if (this.script === 'images') {
        // images 剧本：一轮内并行多次图片搜索——第 2 次触发配额拒绝（每 run 4 张，第 1 次取满）
        for (const id of IMAGE_SEARCH_TOOL_CALL_IDS) {
          parts.push({
            type: 'tool-call',
            toolCallId: id,
            toolName: 'searchContentImages',
            input: JSON.stringify({ query: `产品图 ${id}` }),
          })
        }
      } else if (this.script === 'multi-file') {
        // multi-file 剧本：一轮内并行写三文件（golden multi_file e2e 全链）
        for (const [index, file] of MULTI_FILE_CONTENTS.entries()) {
          parts.push({
            type: 'tool-call',
            toolCallId: `write-file-${index + 1}`,
            toolName: 'writeFile',
            input: JSON.stringify(file),
          })
        }
      } else {
        parts.push({
          type: 'tool-call',
          toolCallId: WRITE_FILE_TOOL_CALL_ID,
          toolName: 'writeFile',
          // arguments 为 JSON 字符串（契约 tool_request.arguments 语义）；
          // writeFile 参数与 Java ProjectFileWriteTool 对齐：relativeFilePath + content（#8 审查整改 A1）
          input: JSON.stringify({ relativeFilePath: 'index.html', content }),
        })
      }
      parts.push({ type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } })
      return { stream: streamFromParts(parts) }
    }
    // 第二轮（工具结果已回喂）
    const tailText = this.script === 'images'
      ? '\n图片资源已收集（配额内）\n'
      : this.script === 'multi-file'
        ? '\n多文件已写入工作区\n'
        : '\n页面已写入 index.html\n'
    const parts: LanguageModelV2StreamPart[] = [
      { type: 'text-start', id: 'tail' },
      { type: 'text-delta', id: 'tail', delta: tailText },
      { type: 'text-end', id: 'tail' },
      { type: 'finish', finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } },
    ]
    return { stream: streamFromParts(parts) }
  }
}

// 质检假模型（reviewer 工位）：按剧本返回 code-quality-check 纯 JSON 文本（isValid/errors/suggestions）。
// #19 质检门禁迁移 generateObject：纯 text JSON 正是 SDK 文本解析路径的输入（doGenerate 收到的
// responseFormat json 提示无需理会，直接回文本即可），schema 校验在 SDK 层完成。
// quality-fail-then-pass：第 1 次质检失败、第 2 次起通过（有界重试后通过剧本）；
// quality-fail-always：永远失败（重试耗尽 → failed）。
class QualityLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const
  readonly provider = 'scripted'
  readonly modelId = 'scripted-quality'
  readonly supportedUrls = {}

  // 质检调用次数（区分 then-pass 剧本的第 1 次与后续）
  private calls = 0

  constructor(
    private readonly script: LlmScript,
    private readonly records: ScriptedCallRecord[],
  ) {}

  private isValidNow(): boolean {
    this.calls += 1
    if (this.script === 'quality-fail-always') return false
    if (this.script === 'quality-fail-then-pass') return this.calls >= 2
    return true
  }

  private buildQualityJson(): string {
    const isValid = this.isValidNow()
    const result = isValid
      ? { isValid: true, errors: [], suggestions: [] }
      : {
          isValid: false,
          errors: ['生成页面缺少必要的视觉还原（模拟质检失败）'],
          suggestions: ['按已确认线框调整页面布局与区块结构'],
        }
    return JSON.stringify(result)
  }

  async doGenerate(options: LanguageModelV2CallOptions) {
    this.records.push({ modelId: this.modelId, maxOutputTokens: options.maxOutputTokens, hasToolResult: hasToolResult(options) })
    const text = this.buildQualityJson()
    return {
      content: [{ type: 'text' as const, text }],
      finishReason: 'stop' as const,
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      warnings: [],
    }
  }

  async doStream(options: LanguageModelV2CallOptions) {
    // 质检走 generateObject（doGenerate）；doStream 为接口完整性
    this.records.push({ modelId: this.modelId, maxOutputTokens: options.maxOutputTokens, hasToolResult: hasToolResult(options) })
    const text = this.buildQualityJson()
    const parts: LanguageModelV2StreamPart[] = [
      { type: 'text-start', id: 'quality' },
      { type: 'text-delta', id: 'quality', delta: text },
      { type: 'text-end', id: 'quality' },
      { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } },
    ]
    return { stream: streamFromParts(parts) }
  }
}

// 工厂：按剧本创建脚本化 provider；注册三档 codegen 模型 + 质检模型。
// records 由 provider 持有，测试经 provider.records 断言路由与档位上限。
export function createScriptedLlm(script: LlmScript = 'success') {
  const records: ScriptedCallRecord[] = []
  const provider = customProvider({
    languageModels: {
      'scripted-fast': new ScriptedLanguageModel(script, 'scripted-fast', records),
      'scripted-standard': new ScriptedLanguageModel(script, 'scripted-standard', records),
      'scripted-deep': new ScriptedLanguageModel(script, 'scripted-deep', records),
      'scripted-quality': new QualityLanguageModel(script, records),
    },
  })
  return Object.assign(provider, { records })
}

// 最小 LLM provider 能力（工作流与质检门禁仅依赖 languageModel 路由到模型）。
// 以 AI SDK customProvider 工厂的返回形态为准——假 provider（本文件）与真 provider（llm/real.ts）
// 均经它构建，接口不寄生在任一实现上；注入点（workflow/review/agent 路由）一律声明为本类型。
export type LlmProvider = Pick<ReturnType<typeof customProvider>, 'languageModel'>
