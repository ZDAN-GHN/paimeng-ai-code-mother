// 三重门禁质检器（Issue #9，架构 §6「验收不靠角色签字，靠机器」）：
// reviewer 工位依次执行三道门禁——结构化质检分（reviewer 模型）→ build 验证 → 视觉 diff（基准=已确认线框）。
// 任一不过 → 质检失败 → 有界重试（状态机 RETRY，见 src/workflow/machine.ts）；全过 → PASS。
// 门禁以接口形式暴露（QualityScorer / BuildVerifier / VisualDiffVerifier），
// 默认实现供生产（MVP 静态校验 + 结构启发式），测试可注入替身以断言「以已确认线框为基准」与失败触发重试。

// 生成类型枚举（架构 §4：createApp 只暴露有构建管线支持的三类）
export type CodeGenType = 'html' | 'multi_file' | 'vue_project'

// token 计量（#9）：prompt/completion 用量，经 GateResult.usage 透传由 workflow 累计进 run.token_usage
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

// 门禁名常量（#9 审查整改：消除跨文件魔数字面量重复；门禁名是汇总/重试定位的键）
export const GATE_NAMES = {
  qualityScore: 'quality-score',
  build: 'build',
  visualDiff: 'visual-diff',
} as const

// 单道门禁的结果
export interface GateResult {
  // 门禁名（GATE_NAMES.qualityScore / GATE_NAMES.build / GATE_NAMES.visualDiff）
  name: string
  passed: boolean
  // 人话说明（失败时给用户看的交代 / 重试注入的修复意见）
  detail: string
  // 本门禁模型调用的 token 用量（#9 计量：质检分门禁经 LLM 调用，计入 run.token_usage）
  usage?: TokenUsage
}

// 质检评审上下文（reviewer 工位运行时收集）
export interface ReviewContext {
  // 工作区绝对路径（产物与线框所在）
  workspacePath: string
  // 已确认线框的绝对路径（视觉 diff 基准；缺省表示无基准可 diff）
  wireframePath?: string
  // 生成类型（html / multi_file / vue_project）：build 门禁按类型分派
  codeGenType: CodeGenType
  // 待审代码内容（拼接后的文件集；质检分门禁的输入）
  codeContent: string
}

// 质检总判决（三重门禁汇总）
export interface ReviewVerdict {
  passed: boolean
  // 各门禁明细（顺序：质检分 → build → 视觉 diff）
  gates: GateResult[]
  // 质检失败的原因（带门禁名的完整交代，供最终失败终态与重试注入修复意见）
  errors: string[]
  // 失败门禁的 detail 去重（修复意见，回喂 coder 的 system；与 errors 同源但无门禁名前缀）
  suggestions: string[]
}

// 门禁接口：verify 返回该门禁结果；workflow 依序执行并汇总
export interface ReviewGate {
  readonly name: string
  verify(context: ReviewContext): Promise<GateResult>
}

// 汇总多道门禁为总判决：全过 → passed；任一失败 → 收集 errors/suggestions
export async function runReviewGates(gates: ReviewGate[], context: ReviewContext): Promise<ReviewVerdict> {
  const results: GateResult[] = []
  for (const gate of gates) {
    results.push(await gate.verify(context))
  }
  const passed = results.every((r) => r.passed)
  const failed = results.filter((r) => !r.passed)
  // errors：带门禁名的完整失败交代（最终 error 终态用）
  const errors = failed.map((r) => `【${r.name}】${r.detail}`)
  // suggestions：失败门禁的 detail 去重（回喂 coder 的修复意见；多道门禁相同 detail 只留一份）
  const suggestions = [...new Set(failed.map((r) => r.detail))]
  return { passed, gates: results, errors, suggestions }
}
