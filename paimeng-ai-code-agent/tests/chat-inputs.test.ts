import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import {
  adoptPending,
  adoptTranscript,
  admitInput,
  applyBoundary,
  dropShownInputs,
  emptySentInputs,
  forgetInput,
  messageSegments,
  placeInput,
  placedInputs,
  queuedInputs,
  transcriptSignature,
  unresolvedInputs,
  type SentInputs,
} from '@/components/chat/chat-inputs';
import type { ChatMessage, ChatInputReceipt, PendingChatInput } from '@/shared/chat-runtime';

const entry = (id: string, mode: 'steer' | 'followUp' = 'steer') => ({ id, mode, text: '补充：' + id, attachments: [] });
const receipt = (id: string, state: ChatInputReceipt['state']): ChatInputReceipt => ({ id, submissionId: 7, generationId: 'task-1', state });
const userMessage = (id: string): ChatMessage => ({ id, role: 'user', parts: [{ type: 'text', text: '补充：' + id }] });
const assistantMessage = (id: string, parts: number): ChatMessage => ({
  id, role: 'assistant', parts: Array.from({ length: parts }, (_, index) => ({ type: 'text', text: '段' + index, state: 'done' })) as UIMessage['parts'],
});

describe('输入回执与落点', () => {
  it('queued 进队列、placed 直接成为气泡（没有队列闪烁）', () => {
    const queued = admitInput(emptySentInputs(), entry('a'), receipt('a', 'queued'));
    expect(queuedInputs(queued, 'steer')).toEqual([{ id: 'a', mode: 'steer', text: '补充：a', attachments: [], submissionId: 7, state: 'queued' }]);
    expect(placedInputs(queued)).toEqual([]);

    const placed = admitInput(emptySentInputs(), entry('b'), receipt('b', 'placed'));
    expect(queuedInputs(placed, 'steer')).toEqual([]);
    expect(placedInputs(placed)).toEqual([{ id: 'b', mode: 'steer', text: '补充：b', attachments: [], boundary: null, messageId: null, state: 'placed' }]);
  });

  it('插话与排队消息在各自的队列里分开显示', () => {
    const state = admitInput(admitInput(emptySentInputs(), entry('a', 'steer'), receipt('a', 'queued')), entry('b', 'followUp'), receipt('b', 'queued'));
    expect(queuedInputs(state, 'steer').map(item => item.id)).toEqual(['a']);
    expect(queuedInputs(state, 'followUp').map(item => item.id)).toEqual(['b']);
  });

  it('data-steer 早于回执到达：落点先暂存，回执到达时直接落到边界', () => {
    const early = applyBoundary(emptySentInputs(), { id: 'a', index: 3 }, 'assistant-1');
    expect(early.items).toEqual([]);
    expect(early.boundaries).toEqual({ a: { boundary: 3, messageId: 'assistant-1' } });

    const admitted = admitInput(early, entry('a'), receipt('a', 'queued'));
    expect(queuedInputs(admitted, 'steer')).toEqual([]);
    expect(placedInputs(admitted)).toEqual([{ id: 'a', mode: 'steer', text: '补充：a', attachments: [], boundary: 3, messageId: 'assistant-1', state: 'placed' }]);
    expect(admitted.boundaries).toEqual({});
  });

  it('落点比迟到的队列回执权威：已到边界就不退回队列', () => {
    const early = applyBoundary(emptySentInputs(), { id: 'a', index: 1 }, 'assistant-1');
    const admitted = admitInput(early, entry('a'), receipt('a', 'queued'));
    expect(queuedInputs(admitted, 'steer')).toEqual([]);
    expect(placedInputs(admitted)[0]).toMatchObject({ id: 'a', boundary: 1, messageId: 'assistant-1' });
  });

  it('轮询先恢复、data-steer 再落地、回执最后到：已交付状态不被迟到回执退回队列', () => {
    const recovered = adoptPending(emptySentInputs(), [{ id: 'a', mode: 'steer', text: '补充：a', attachments: [], submissionId: 9 }]);
    const landed = applyBoundary(recovered, { id: 'a', index: 2 }, 'assistant-1');
    expect(landed.boundaries).toEqual({});
    const admitted = admitInput(landed, entry('a'), receipt('a', 'queued'));
    expect(queuedInputs(admitted, 'steer')).toEqual([]);
    expect(placedInputs(admitted)).toEqual([{ id: 'a', mode: 'steer', text: '补充：a', attachments: [], boundary: 2, messageId: 'assistant-1', state: 'placed' }]);
  });

  it('回执先到、data-steer 后到：队列项落到边界并离开队列', () => {
    const state = applyBoundary(admitInput(emptySentInputs(), entry('a'), receipt('a', 'queued')), { id: 'a', index: 2 }, 'assistant-1');
    expect(queuedInputs(state, 'steer')).toEqual([]);
    expect(placedInputs(state)[0]).toMatchObject({ id: 'a', boundary: 2, messageId: 'assistant-1' });
  });
});

describe('运行态对齐', () => {
  const pending: PendingChatInput[] = [
    { id: 'a', mode: 'steer', text: '补充：a', attachments: [], submissionId: 11 },
    { id: 'b', mode: 'followUp', text: '排队：b', attachments: [], submissionId: 12 },
  ];

  it('刷新后从服务端原生队列恢复队列项，本地已有的不重复', () => {
    const local = admitInput(emptySentInputs(), entry('a'), receipt('a', 'queued'));
    const state = adoptPending(local, pending);
    expect(queuedInputs(state, 'steer')).toEqual([{ id: 'a', mode: 'steer', text: '补充：a', attachments: [], submissionId: 7, state: 'queued' }]);
    expect(queuedInputs(state, 'followUp')).toEqual([{ id: 'b', mode: 'followUp', text: '排队：b', attachments: [], submissionId: 12, state: 'queued' }]);
  });

  it('本地还没拿到撤回凭据时用服务端的补上', () => {
    const local: SentInputs = { items: [{ id: 'a', mode: 'steer', text: '补充：a', attachments: [], state: 'queued', submissionId: null }], boundaries: {} };
    expect(queuedInputs(adoptPending(local, pending), 'steer')[0].submissionId).toBe(11);
  });

  it('已经放进待重发区的输入不再回到队列', () => {
    const state = adoptPending(emptySentInputs(), pending, ['a']);
    expect(queuedInputs(state, 'steer')).toEqual([]);
    expect(queuedInputs(state, 'followUp').map(item => item.id)).toEqual(['b']);
    expect(queuedInputs(adoptPending(emptySentInputs(), pending, ['a', 'b']), 'followUp')).toEqual([]);
  });

  it('转录里已经有这条输入时认领成交付气泡（断流后收不到 data-steer 也能对齐）', () => {
    const state = adoptTranscript(admitInput(emptySentInputs(), entry('a'), receipt('a', 'queued')), [userMessage('a'), assistantMessage('assistant-1', 2)]);
    expect(queuedInputs(state, 'steer')).toEqual([]);
    expect(placedInputs(state)[0]).toMatchObject({ id: 'a', boundary: null });
    expect(adoptTranscript(state, [])).toBe(state);
  });

  it('权威转录接管显示时把已由它渲染的本地输入收起来（不会重复显示一条）', () => {
    const state = admitInput(emptySentInputs(), entry('a'), receipt('a', 'placed'));
    expect(dropShownInputs(state, [userMessage('a')])).toEqual(emptySentInputs());
    expect(dropShownInputs(state, [userMessage('other')])).toBe(state);
  });

  it('撤回成功就出队，服务端说已经进上下文时按交付处理', () => {
    const state = admitInput(emptySentInputs(), entry('a'), receipt('a', 'queued'));
    expect(forgetInput(state, 'a').items).toEqual([]);
    expect(placedInputs(placeInput(state, 'a'))[0]).toMatchObject({ id: 'a', boundary: null });
  });

  it('终态把转录里没有的输入交回调用方，文字与附件都在', () => {
    const attachments = [{ type: 'attachment' as const, attachmentId: 'a-1', mediaType: 'image/png' as const, filename: 'a.png' }];
    const state = admitInput(admitInput(emptySentInputs(), entry('a'), receipt('a', 'queued')), { id: 'b', mode: 'followUp', text: '带附件的排队', attachments }, receipt('b', 'queued'));
    expect(unresolvedInputs(state, [userMessage('a')])).toEqual([{ id: 'b', mode: 'followUp', text: '带附件的排队', attachments }]);
    expect(unresolvedInputs(state, [])).toHaveLength(2);
  });

  it('运行态签名随文字长度与工具状态变化，内容不变时保持相等', () => {
    const running = [{ id: 'assistant-1', role: 'assistant' as const, parts: [{ type: 'dynamic-tool' as const, toolName: 'write', toolCallId: 'c1', state: 'input-available' as const, input: {} }] }];
    const done = [{ id: 'assistant-1', role: 'assistant' as const, parts: [{ type: 'dynamic-tool' as const, toolName: 'write', toolCallId: 'c1', state: 'output-available' as const, input: {}, output: '已写入' }] }];
    expect(transcriptSignature(running)).toBe(transcriptSignature(running));
    expect(transcriptSignature(running)).not.toBe(transcriptSignature(done));
    expect(transcriptSignature([assistantMessage('assistant-1', 1)])).not.toBe(transcriptSignature([assistantMessage('assistant-1', 2)]));
  });
});

describe('按边界分段', () => {
  const parts = assistantMessage('assistant-1', 3).parts;
  const placed = (id: string, boundary: number | null) => ({ id, mode: 'steer' as const, text: '补充：' + id, attachments: [], boundary, messageId: 'assistant-1' });

  it('没有落地的输入就是一个整段，空的 part 列表不产出空段', () => {
    expect(messageSegments(parts, [])).toEqual([{ kind: 'assistant', parts }]);
    expect(messageSegments(parts, [placed('a', null)])).toEqual([{ kind: 'assistant', parts }]);
  });

  it('按落点切成前段 / 输入 / 后段，顺序按 part 数', () => {
    const segments = messageSegments(parts, [placed('b', 2), placed('a', 1)]);
    expect(segments.map(segment => segment.kind === 'input' ? segment.input.id : segment.parts.length)).toEqual([1, 'a', 1, 'b', 1]);
  });

  it('落点越界或乱序也不会丢内容或倒序', () => {
    const segments = messageSegments(parts, [placed('a', 9), placed('b', 0)]);
    expect(segments.map(segment => segment.kind === 'input' ? segment.input.id : segment.parts.length)).toEqual(['b', 3, 'a']);
  });
});
