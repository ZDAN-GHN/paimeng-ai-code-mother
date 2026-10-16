import { describe, expect, it } from 'vitest';
import {
  composerAction,
  dequeue,
  enqueue,
  initialProgress,
  interruptedStreamMessage,
  parseProgressEvent,
  progressReducer,
  removeQueued,
  settleProgress,
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

  it('构建阶段进行中的保活事件刷新已用时长，完成后换成真实耗时', () => {
    const running = feed([
      { stage: 'install', status: 'started', ms: 0, at: 1 },
      { stage: 'install', status: 'started', ms: 1200, at: 1201 },
      { stage: 'install', status: 'started', ms: 3400, at: 3401 },
    ]);
    expect(running.stages.at(-1)).toEqual({ kind: 'install', status: 'running', ms: 3400 });
    const done = feed([{ stage: 'install', status: 'ok', ms: 15400, at: 15400 }], running);
    expect(done.stages.at(-1)).toEqual({ kind: 'install', status: 'ok', ms: 15400 });
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

describe('进度归约', () => {
  it('终态事件收尾所有进行中的阶段：构建中途被取消时不再有「运行中」', () => {
    const cancelled = feed([
      { stage: 'files', paths: ['index.html'], at: 1000 },
      { stage: 'source', status: 'ok', ms: 120, at: 1200 },
      { stage: 'install', status: 'started', ms: 0, at: 1300 },
      { stage: 'cancelled', at: 9000 },
    ]);
    expect(cancelled.outcome).toBe('cancelled');
    expect(cancelled.stages).toEqual([
      { kind: 'generate', status: 'cancelled', ms: 8000 },
      { kind: 'files', status: 'cancelled', count: 1, lastPath: 'index.html' },
      { kind: 'source', status: 'ok', ms: 120 },
      { kind: 'install', status: 'cancelled', ms: null },
    ]);

    const failed = feed([{ stage: 'typecheck', status: 'started', ms: 0, at: 5 }, { stage: 'failed', at: 9 }]);
    expect(failed.stages.map(stage => stage.status)).toEqual(['failed', 'failed']);
    const ready = feed([{ stage: 'install', status: 'started', ms: 0, at: 5 }, { stage: 'ready', at: 9 }]);
    expect(ready.stages.map(stage => stage.status)).toEqual(['ok', 'ok']);
  });
});

describe('流中断兜底', () => {
  const interrupted = feed([
    { stage: 'files', paths: ['index.html'], at: 1000 },
    { stage: 'source', status: 'ok', ms: 120, at: 1200 },
    { stage: 'install', status: 'started', ms: 0, at: 1300 },
  ]);

  it('连接中断后按任务状态收尾：运行中的阶段判成终态，不再转圈', () => {
    const settled = settleProgress(interrupted, 'cancelled');
    expect(settled.outcome).toBe('cancelled');
    expect(settled.stages).toEqual([
      { kind: 'generate', status: 'cancelled', ms: null },
      { kind: 'files', status: 'cancelled', count: 1, lastPath: 'index.html' },
      { kind: 'source', status: 'ok', ms: 120 },
      { kind: 'install', status: 'cancelled', ms: null },
    ]);
  });

  it('ready 收尾时运行中的阶段算成功，任务失败时算失败', () => {
    expect(settleProgress(interrupted, 'ready').stages.map(stage => stage.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(settleProgress(interrupted, 'failed').stages.map(stage => stage.status)).toEqual(['failed', 'failed', 'ok', 'failed']);
  });
});

describe('连接中断的可读文案', () => {
  it('浏览器与 SDK 的传输层原文换成可读文案，并按任务状态区分', () => {
    const raw = ['Error in input stream', 'Failed to fetch', 'NetworkError when attempting to fetch resource', 'network error', 'Load failed', 'socket hang up'];
    for (const message of raw) {
      expect(interruptedStreamMessage({ message, status: 'cancelled' })).toBe('生成连接中断，任务已取消；可重新发送需求继续');
    }
    expect(interruptedStreamMessage({ message: 'Error in input stream', status: 'failed' })).toContain('任务已失败');
    expect(interruptedStreamMessage({ message: 'Error in input stream', status: 'ready' })).toContain('已经完成');
    expect(interruptedStreamMessage({ message: 'Error in input stream', status: 'generating' })).toContain('可能仍在后台');
    expect(interruptedStreamMessage({ message: 'Error in input stream', status: null })).toContain('可能仍在后台');
  });

  it('其它错误照原样展示：模型错误、业务错误与取消失败都不是连接中断', () => {
    expect(interruptedStreamMessage({ message: '模型响应失败', status: 'failed' })).toBeNull();
    expect(interruptedStreamMessage({ message: '生成或构建失败，请查看任务状态', status: 'failed' })).toBeNull();
    expect(interruptedStreamMessage({ message: '当前没有正在生成的步骤，插话不适用', status: 'generating' })).toBeNull();
  });
});
