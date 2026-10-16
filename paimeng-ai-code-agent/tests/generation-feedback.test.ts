import { describe, expect, it } from 'vitest';
import {
  composerAction,
  dequeue,
  enqueue,
  initialProgress,
  parseProgressEvent,
  progressReducer,
  removeQueued,
  type ProgressState,
} from '@/components/chat/generation-feedback';
import type { BuildProgressEvent } from '@/shared/contracts';

const key = (overrides: Partial<Parameters<typeof composerAction>[0]> = {}) => ({
  key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, generating: false, ...overrides,
});

describe('对话输入键位', () => {
  it('空闲时 Enter / Ctrl+Enter 都直接发送', () => {
    expect(composerAction(key())).toBe('send');
    expect(composerAction(key({ ctrlKey: true }))).toBe('send');
    expect(composerAction(key({ metaKey: true }))).toBe('send');
  });

  it('生成中 Enter 排队，Ctrl / Meta + Enter 中途插话', () => {
    expect(composerAction(key({ generating: true }))).toBe('queue');
    expect(composerAction(key({ generating: true, ctrlKey: true }))).toBe('steer');
    expect(composerAction(key({ generating: true, metaKey: true }))).toBe('steer');
  });

  it('Shift + Enter 始终换行，其它按键不处理', () => {
    expect(composerAction(key({ shiftKey: true }))).toBe('newline');
    expect(composerAction(key({ shiftKey: true, generating: true }))).toBe('newline');
    expect(composerAction(key({ shiftKey: true, ctrlKey: true, generating: true }))).toBe('newline');
    expect(composerAction(key({ key: 'a' }))).toBe('none');
    expect(composerAction(key({ key: 'Escape', generating: true }))).toBe('none');
  });
});

describe('排队消息', () => {
  it('按先后进队，空白文本不入队', () => {
    expect(enqueue([], '  第一条  ')).toEqual(['第一条']);
    expect(enqueue(['第一条'], '第二条')).toEqual(['第一条', '第二条']);
    expect(enqueue(['第一条'], '   ')).toEqual(['第一条']);
  });

  it('出队取队首并返回剩余，空队列返回 null', () => {
    expect(dequeue(['a', 'b'])).toEqual({ head: 'a', rest: ['b'] });
    expect(dequeue([])).toEqual({ head: null, rest: [] });
  });

  it('按位置删除排队项', () => {
    expect(removeQueued(['a', 'b', 'c'], 1)).toEqual(['a', 'c']);
    expect(removeQueued(['a'], 5)).toEqual(['a']);
  });
});

describe('进度事件校验', () => {
  it('合法事件通过，形状不合法返回 null', () => {
    expect(parseProgressEvent({ stage: 'files', paths: ['index.html'], at: 1 })).toEqual({ stage: 'files', paths: ['index.html'], at: 1 });
    expect(parseProgressEvent({ stage: 'ready', at: 9 })).toEqual({ stage: 'ready', at: 9 });
    expect(parseProgressEvent({ stage: 'install', status: 'ok', ms: 1200, at: 3 })).toEqual({ stage: 'install', status: 'ok', ms: 1200, at: 3 });
    expect(parseProgressEvent({ stage: 'files', paths: 'index.html', at: 1 })).toBeNull();
    expect(parseProgressEvent({ stage: 'nope', at: 1 })).toBeNull();
    expect(parseProgressEvent(null)).toBeNull();
    expect(parseProgressEvent('ready')).toBeNull();
  });
});

const feed = (events: BuildProgressEvent[], state: ProgressState = initialProgress()) => events.reduce(progressReducer, state);

describe('进度归约', () => {
  it('第一个事件补上生成阶段，写入文件累计个数与最近文件名', () => {
    const state = feed([
      { stage: 'files', paths: ['index.html'], at: 10 },
      { stage: 'files', paths: ['style.css', 'main.js'], at: 20 },
    ]);
    expect(state.outcome).toBe('running');
    expect(state.stages).toEqual([
      { kind: 'generate', status: 'running', ms: null },
      { kind: 'files', status: 'running', count: 3, lastPath: 'main.js' },
    ]);
  });

  it('构建阶段保留状态与耗时，started 时耗时未知', () => {
    const state = feed([
      { stage: 'source', status: 'started', ms: 0, at: 1 },
      { stage: 'source', status: 'ok', ms: 350, at: 2 },
      { stage: 'install', status: 'ok', ms: 21000, at: 3 },
      { stage: 'typecheck', status: 'failed', ms: 4000, at: 4 },
    ]);
    const stages = state.stages.filter(stage => stage.kind !== 'generate' && stage.kind !== 'files');
    expect(stages).toEqual([
      { kind: 'source', status: 'ok', ms: 350 },
      { kind: 'install', status: 'ok', ms: 21000 },
      { kind: 'typecheck', status: 'failed', ms: 4000 },
    ]);
  });

  it('ready 收尾：生成阶段耗时取首末事件时间差', () => {
    const state = feed([
      { stage: 'files', paths: ['index.html'], at: 1000 },
      { stage: 'preview', version: 1, at: 4000 },
      { stage: 'ready', at: 4600 },
    ]);
    expect(state.outcome).toBe('ready');
    expect(state.stages[0]).toEqual({ kind: 'generate', status: 'ok', ms: 3600 });
    expect(state.stages.find(stage => stage.kind === 'preview')).toEqual({ kind: 'preview', status: 'ok', version: 1 });
  });

  it('failed 与 cancelled 各自的终态', () => {
    const failed = feed([{ stage: 'install', status: 'failed', ms: 500, at: 5 }, { stage: 'failed', at: 9 }]);
    expect(failed.outcome).toBe('failed');
    expect(failed.stages[0]).toEqual({ kind: 'generate', status: 'failed', ms: 4 });

    const cancelled = feed([{ stage: 'install', status: 'ok', ms: 500, at: 5 }, { stage: 'cancelled', at: 9 }]);
    expect(cancelled.outcome).toBe('cancelled');
    expect(cancelled.stages[0]).toEqual({ kind: 'generate', status: 'cancelled', ms: 4 });
  });

  it('终态后再来事件视为新一次生成，先重置', () => {
    const first = feed([{ stage: 'files', paths: ['a.html'], at: 1 }, { stage: 'ready', at: 2 }]);
    const second = feed([
      { stage: 'source', status: 'ok', ms: 90, at: 100 },
      { stage: 'preview', version: 2, at: 200 },
    ], first);
    expect(second.outcome).toBe('running');
    expect(second.stages).toEqual([
      { kind: 'generate', status: 'running', ms: null },
      { kind: 'source', status: 'ok', ms: 90 },
      { kind: 'preview', status: 'ok', version: 2 },
    ]);
    expect(second.startedAt).toBe(100);
  });

  it('preview 版本取最新一次事件', () => {
    const state = feed([
      { stage: 'preview', version: 1, at: 1 },
      { stage: 'preview', version: 4, at: 2 },
    ]);
    expect(state.stages.find(stage => stage.kind === 'preview')).toEqual({ kind: 'preview', status: 'ok', version: 4 });
  });
});
