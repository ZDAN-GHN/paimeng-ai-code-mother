'use client';
import { CheckCircleFilled, CloseCircleFilled, LoadingOutlined, MinusCircleFilled } from '@ant-design/icons';
import { Spin } from 'antd';
import { formatDuration } from '@/components/chat/generation-usage';
import { buildStageLabels, type ProgressStage, type ProgressState, type StageStatus } from '@/components/chat/generation-feedback';

/** 生成/构建时间线：只渲染实际发生过的阶段，已完成显示耗时，失败阶段标红。 */
const stageLabels: Record<ProgressStage['kind'], string> = {
  generate: '生成',
  files: '写入文件',
  preview: '预览就绪',
  ...buildStageLabels,
};

function iconOf(status: StageStatus) {
  if (status === 'running') return <Spin indicator={<LoadingOutlined />} size="small" />;
  if (status === 'ok') return <CheckCircleFilled />;
  if (status === 'failed') return <CloseCircleFilled />;
  return <MinusCircleFilled />;
}

function metaOf(stage: ProgressStage) {
  if (stage.kind === 'files') return `${stage.count} 个文件${stage.lastPath ? ` · 最近 ${stage.lastPath}` : ''}`;
  if (stage.kind === 'preview') return `v${stage.version}`;
  return '';
}

function durationOf(stage: ProgressStage) {
  if (stage.kind === 'files' || stage.kind === 'preview') return null;
  if (stage.ms === null) return null;
  // 运行中的阶段靠保活事件每秒刷新 ms：显式写「已用」，避免和已完成阶段的耗时混淆。
  return stage.status === 'running' ? `已用 ${formatDuration(stage.ms)}` : formatDuration(stage.ms);
}

export function BuildProgress({ state, error }: { state: ProgressState; error: string | null }) {
  if (!state.stages.length) return null;
  const failed = state.outcome === 'failed' || state.stages.some(stage => stage.status === 'failed');
  return <div className="build-progress" role="status" aria-label="生成进度">
    <ol className="build-progress-list">
      {state.stages.map(stage => {
        const meta = metaOf(stage);
        const duration = durationOf(stage);
        return <li key={stage.kind} className={'build-progress-item build-progress-' + stage.status}>
          <span className="build-progress-icon" aria-hidden="true">{iconOf(stage.status)}</span>
          <span className="build-progress-label">{stageLabels[stage.kind]}</span>
          {meta && <span className="build-progress-meta">{meta}</span>}
          {duration && <span className="build-progress-ms">{duration}</span>}
        </li>;
      })}
    </ol>
    {failed && error && <p className="build-progress-error">{error}</p>}
  </div>;
}
