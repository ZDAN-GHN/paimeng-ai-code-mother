'use client';
import type { AccountStep, GenerationAccount, GenerationStopReason } from '@/shared/contracts';

/** 停止原因的中文文案：用量块与 Credit 行共用同一份，别在两处各写一套词。 */
export const stopReasonLabels: Record<GenerationStopReason, string> = {
  completed: '已完成',
  'no-changes': '模型没有修改文件',
  'step-limit': '步数用尽',
  'verification-failed': '构建未通过',
  timeout: '超时',
  cancelled: '已取消',
  'lease-lost': '租约失效',
  'model-error': '模型错误',
  'initialization-failed': '初始化失败',
  interrupted: '进程中断',
  question: '等待回答',
  overdraft: '超出透支线，已中止',
};

const finishReasonLabels: Record<string, string> = {
  stop: '正常结束',
  length: '达到长度上限',
  'tool-calls': '调用工具',
  'content-filter': '内容被过滤',
  error: '模型报错',
};

const stageLabels: Record<string, string> = {
  install: '安装依赖',
  source: '源码校验',
  typecheck: '类型检查',
  build: '打包',
};

const statusLabels: Record<string, string> = { ok: '通过', error: '未通过', cancelled: '已取消' };
/** 生成状态的中文文案：对话页用量块与 Admin 待处理列表共用。 */
export const generationStatusLabels: Record<string, string> = { generating: '生成中', building: '构建中', ready: '已完成', failed: '失败', cancelled: '已取消' };

export function formatDuration(ms: number | null) {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds - minutes * 60)}s`;
}

const formatCount = (value: number | null) => value === null ? '未返回' : value.toLocaleString('zh-CN');

function stepLabel(step: AccountStep) {
  if (step.kind === 'build') return `第 ${step.round} 轮构建${step.stage ? ` · ${stageLabels[step.stage] ?? step.stage}` : ''}`;
  if (step.kind === 'summary') return '整理历史上下文';
  return `第 ${step.round} 轮 · 第 ${step.stepNumber + 1} 步`;
}

function stepTools(step: AccountStep) {
  if (!step.toolCalls.length) return null;
  return <span className="generation-usage-tools">
    {step.toolCalls.map((call, index) => <span key={index} className={call.ok ? undefined : 'generation-usage-tool-failed'}>
      {call.name}{call.ok ? '' : ' 失败'} {formatDuration(call.ms)}
    </span>)}
  </span>;
}

function stepOutcome(step: AccountStep) {
  if (step.kind === 'build') return <>{statusLabels[step.status] ?? step.status}{step.detail ? <span className="generation-usage-detail" title={step.detail}>{step.detail.slice(0, 120)}</span> : null}</>;
  if (step.kind === 'summary') return <>{statusLabels[step.status] ?? step.status}{step.detail ? <span className="generation-usage-detail" title={step.detail}>{step.detail.slice(0, 120)}</span> : null}</>;
  return <>{step.finishReason ? finishReasonLabels[step.finishReason] ?? step.finishReason : '—'}</>;
}

function stepTokens(step: AccountStep) {
  if (step.kind === 'build') return '—';
  const cache = step.cacheReadTokens ? `（缓存读 ${step.cacheReadTokens.toLocaleString('zh-CN')}）` : '';
  return `输入 ${formatCount(step.inputTokens)} / 输出 ${formatCount(step.outputTokens)}${cache}`;
}

/** 本次生成的用量明细（D2 记账）。只在任务结束后展示，生成中不轮询。 */
export function GenerationUsage({ usage }: { usage: GenerationAccount }) {
  const { model, summary, build, totalMs, rounds } = usage.totals;
  const tokens = model.usageUnknown || model.inputTokens === null
    ? '用量未返回'
    : `输入 ${model.inputTokens.toLocaleString('zh-CN')} / 输出 ${(model.outputTokens ?? 0).toLocaleString('zh-CN')} tokens`;
  const upstream = usage.steps.find(step => step.upstreamModelId);
  const brief = [
    usage.stopReason ? stopReasonLabels[usage.stopReason] : generationStatusLabels[usage.status] ?? usage.status,
    `${model.steps} 步模型调用${rounds > 1 ? `（${rounds} 轮）` : ''}`,
    `模型 ${formatDuration(model.modelMs)}`,
    model.toolMs > 0 ? `工具 ${formatDuration(model.toolMs)}` : null,
    build.attempts > 0 ? `构建 ${build.attempts} 次 ${formatDuration(build.buildMs)}` : '未构建',
    summary.calls > 0 ? `整理历史 ${summary.calls} 次 ${formatDuration(summary.summaryMs)}` : null,
    tokens,
    totalMs !== null ? `总用时 ${formatDuration(totalMs)}` : null,
  ].filter(Boolean).join(' · ');
  return <details className="generation-usage">
    <summary><span className="generation-usage-title">本次生成用量</span><span className="generation-usage-brief">{brief}</span></summary>
    <div className="generation-usage-body">
      <p className="generation-usage-model">
        模型绑定 {usage.model.alias ?? '未知'}
        {upstream ? ` · 上游 ${upstream.upstreamProvider ?? '未知'}/${upstream.upstreamModelId ?? '未知'}` : ''}
        {usage.error ? ` · 失败原因 ${usage.error}` : ''}
      </p>
      <table className="generation-usage-table">
        <thead><tr><th scope="col">步骤</th><th scope="col">耗时</th><th scope="col">用量</th><th scope="col">结果</th></tr></thead>
        <tbody>
          {usage.steps.map(step => <tr key={step.id}>
            <td><span className="generation-usage-step">{stepLabel(step)}</span>{stepTools(step)}</td>
            <td>{formatDuration(step.durationMs)}</td>
            <td>{stepTokens(step)}</td>
            <td>{stepOutcome(step)}</td>
          </tr>)}
          {!usage.steps.length && <tr><td colSpan={4}>这次任务没有留下步骤记录。</td></tr>}
        </tbody>
      </table>
    </div>
  </details>;
}
