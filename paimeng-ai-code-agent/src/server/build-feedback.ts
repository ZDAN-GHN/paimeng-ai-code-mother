/**
 * 构建失败的分类与模型可读诊断。纯函数，不依赖运行时。
 *
 * 阶段标记通过 WeakMap 挂在错误对象上：不改错误类型、消息与对外序列化，
 * 只让 agent.ts 判断这次失败能否交给模型修复。见 docs/plans/agent-design-review.md §8。
 */
export type BuildStage = 'source' | 'template' | 'install' | 'typecheck' | 'build' | 'platform';
/** 能定位到生成源码、因而可以交给模型修复的阶段。 */
export type RepairableStage = 'source' | 'typecheck' | 'build';
export type BuildFailure = { stage: BuildStage; detail?: string };
export type BuildVerdict =
  | { repairable: true; stage: RepairableStage }
  | { repairable: false; stage: BuildStage | 'unknown'; reason: string };

const failures = new WeakMap<Error, BuildFailure>();
// 容器输出里来自环境或资源、而非生成源码的特征：命中后即使阶段本身可修复也不再交给模型。
const environmentSignatures = ['killed', 'out of memory', 'enospc', 'no space left', 'econnreset', 'etimedout', 'enotfound', 'sigkill'];

export function markBuildFailure<T extends Error>(error: T, failure: BuildFailure): T {
  failures.set(error, failure);
  return error;
}

/** 把失败标记成源自生成源码；非 Error 会被包装，消息保持不变。 */
export function sourceFailure(error: unknown): Error {
  const source = error instanceof Error ? error : new Error(String(error));
  return markBuildFailure(source, { stage: 'source' });
}

export function buildFailureOf(error: unknown): BuildFailure | null {
  return error instanceof Error ? failures.get(error) ?? null : null;
}

/** 没打标记的失败一律不交给模型：宁可少给一次机会，也不把无法解释的失败喂给模型。 */
export function classifyBuildFailure(error: unknown): BuildVerdict {
  const failure = buildFailureOf(error);
  if (!failure) return { repairable: false, stage: 'unknown', reason: '无法定位到源码的失败' };
  if (failure.stage === 'source') return { repairable: true, stage: 'source' };
  if (failure.stage === 'typecheck' || failure.stage === 'build') {
    const output = failure.detail?.toLowerCase() ?? '';
    return environmentSignatures.some(signature => output.includes(signature))
      ? { repairable: false, stage: failure.stage, reason: '容器环境或资源问题，不来自生成源码' }
      : { repairable: true, stage: failure.stage };
  }
  if (failure.stage === 'template') return { repairable: false, stage: 'template', reason: '模板依赖锁被改动，模型无权修复' };
  if (failure.stage === 'install') return { repairable: false, stage: 'install', reason: '依赖安装失败，与生成源码无关' };
  return { repairable: false, stage: 'platform', reason: '平台侧失败' };
}

const diagnosticChars = 4000;
const summaryChars = 800;
const stageLabels: Record<BuildStage | 'unknown', string> = { source: '源码校验', template: '模板依赖', install: '安装依赖', typecheck: '类型检查', build: '打包构建', platform: '平台环境', unknown: '未知阶段' };

function messageOf(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, summaryChars);
}

/** 容器内路径（--workdir /work）归一化成工程相对路径，模型才能用 readFile 的路径直接对上。 */
function normalizeContainerPaths(text: string) {
  return text.split('/work/').join('');
}

/** 有界诊断：保留原始换行，超长时留头留尾并标注省略量。 */
function boundedDetail(text: string) {
  if (text.length <= diagnosticChars) return text;
  const headChars = Math.floor(diagnosticChars * 0.4);
  const tailChars = diagnosticChars - headChars;
  return [text.slice(0, headChars), `…（已省略 ${text.length - diagnosticChars} 个字符）…`, text.slice(-tailChars)].join('\n');
}

export function formatBuildFeedback(error: unknown, attempt: number, maxAttempts: number): string {
  const failure = buildFailureOf(error);
  const detail = failure?.detail ? boundedDetail(normalizeContainerPaths(failure.detail).trim()) : '';
  return [
    `验证未通过（第 ${attempt} 次修复，共 ${maxAttempts} 次）。阶段：${stageLabels[failure?.stage ?? 'unknown']}。`,
    `错误摘要：${messageOf(error)}`,
    detail ? `最近构建输出（保留换行；过长时省略中间）：\n${detail}` : '',
    '请只修改导致该错误的源码：不要重新生成整个工程，不要修改 package.json 依赖、锁文件或模板文件，也不要改应用类型。改完直接结束回复，平台会自动重新验证。',
  ].filter(line => line).join('\n');
}

/** 无进展终止：保留原始构建错误作为主错误，只补充「本轮模型没有改文件」这一事实。 */
export function noProgressMessage(error: unknown): string {
  return `${messageOf(error)}；本轮模型未修改任何文件，已停止继续修复`;
}
