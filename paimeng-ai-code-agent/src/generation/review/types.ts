






export type CodeGenType = 'html' | 'multi_file' | 'vue_project'


export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}


export const GATE_NAMES = {
  qualityScore: 'quality-score',
  build: 'build',
  visualDiff: 'visual-diff',
} as const


export interface GateResult {

  name: string
  passed: boolean

  detail: string

  usage?: TokenUsage
}


export interface ReviewContext {

  workspacePath: string

  wireframePath?: string

  codeGenType: CodeGenType

  codeContent: string
}


export interface ReviewVerdict {
  passed: boolean

  gates: GateResult[]

  errors: string[]

  suggestions: string[]
}


export interface ReviewGate {
  readonly name: string
  verify(context: ReviewContext): Promise<GateResult>
}


export async function runReviewGates(gates: ReviewGate[], context: ReviewContext): Promise<ReviewVerdict> {
  const results: GateResult[] = []
  for (const gate of gates) {
    results.push(await gate.verify(context))
  }
  const passed = results.every((r) => r.passed)
  const failed = results.filter((r) => !r.passed)

  const errors = failed.map((r) => `【${r.name}】${r.detail}`)

  const suggestions = [...new Set(failed.map((r) => r.detail))]
  return { passed, gates: results, errors, suggestions }
}
