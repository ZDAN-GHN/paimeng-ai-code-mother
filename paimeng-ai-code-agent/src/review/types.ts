// 三重门禁质检器（Issue #9，架构 §6「验收不靠角色签字，靠机器」）：
// reviewer 工位依次执行三道门禁——结构化质检分（reviewer 模型）→ build 验证 → 视觉 diff（基准=已确认线框）。
// 任一不过 → 质检失败 → 有界重试（状态机 RETRY，见 src/workflow/machine.ts）；全过 → PASS。
// 门禁以接口形式暴露（QualityScorer / BuildVerifier / VisualDiffVerifier），
// 默认实现供生产（MVP 静态校验 + 结构启发式），测试可注入替身以断言「以已确认线框为基准」与失败触发重试。

// 单道门禁的结果
export interface GateResult {
  // 门禁名（'quality-score' / 'build' / 'visual-diff'）
  name: string
  passed: boolean
  // 人话说明（失败时给用户看的交代 / 重试注入的修复意见）
  detail: string
}

// 质检评审上下文（reviewer 工位运行时收集）
export interface ReviewContext {
  // 工作区绝对路径（产物与线框所在）
  workspacePath: string
  // 已确认线框的绝对路径（视觉 diff 基准；缺省表示无基准可 diff）
  wireframePath?: string
  // 生成类型（html / multi_file / vue_project）：build 门禁按类型分派
  codeGenType: string
  // 待审代码内容（拼接后的文件集；质检分门禁的输入）
  codeContent: string
}

// 质检总判决（三重门禁汇总）
export interface ReviewVerdict {
  passed: boolean
  // 各门禁明细（顺序：质检分 → build → 视觉 diff）
  gates: GateResult[]
  // 质检失败的原因（供重试注入修复意见与错误交代）
  errors: string[]
  // 改进建议（随修复意见回喂 coder）
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
  const errors = failed.map((r) => `【${r.name}】${r.detail}`)
  // 建议仅取失败门禁的 detail（成功门禁无建议语义）
  const suggestions = failed.map((r) => r.detail)
  return { passed, gates: results, errors, suggestions }
}
