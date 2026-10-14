import type { HistoryBlock, HistoryTurn, MemoryBudgets, MemoryMessage, MemoryPart, TurnOutcome } from '@/server/memory-types';

export function textPart(text: string): MemoryPart {
  return { type: 'text', text };
}

export function toolPart(name: string, input: unknown, options: { output?: unknown; errorText?: string } = {}): MemoryPart {
  return { type: `tool-${name}`, toolName: name, input, output: options.output, errorText: options.errorText, state: options.errorText ? 'output-error' : 'output-available' };
}

export function message(sequence: number, role: 'user' | 'assistant', parts: MemoryPart[]): MemoryMessage {
  return { id: `${role}-${sequence}`, sequence: String(sequence), role, parts };
}

export function turn(spec: {
  start: number;
  end?: number;
  userText?: string;
  assistantText?: string;
  parts?: MemoryPart[];
  terminal?: boolean;
  outcome?: TurnOutcome | null;
  legacy?: boolean;
  block?: HistoryBlock;
}): HistoryTurn {
  const end = spec.end ?? spec.start + 1;
  const messages: MemoryMessage[] = [message(spec.start, 'user', [textPart(spec.userText ?? '继续')])];
  if (spec.parts) messages.push(message(end, 'assistant', spec.parts));
  else messages.push(message(end, 'assistant', [textPart(spec.assistantText ?? '完成')]));
  return {
    startSequence: String(spec.start),
    endSequence: String(end),
    messages,
    terminal: spec.terminal ?? true,
    outcome: spec.outcome ?? 'ready',
    legacy: spec.legacy ?? false,
    block: spec.block ?? 'native',
  };
}

/** 固定字符数的回合，用于精确控制预算测试。 */
export function sizedTurn(start: number, chars: number, extra: Partial<{ terminal: boolean; outcome: TurnOutcome; block: HistoryBlock }> = {}): HistoryTurn {
  return turn({ start, assistantText: 'x'.repeat(chars), ...extra });
}

export function activeTurn(start: number, text = '仍在处理'): HistoryTurn {
  return {
    startSequence: String(start),
    endSequence: String(start + 1),
    messages: [message(start, 'user', [textPart('继续')]), message(start + 1, 'assistant', [textPart(text)])],
    terminal: false,
    outcome: null,
    legacy: false,
    block: 'native',
  };
}

/** 补迁旧历史的回合：消息 id 带 legacy- 前缀，属于 legacy 区块。 */
export function legacyTurn(start: number, text = '旧历史需求'): HistoryTurn {
  return {
    startSequence: String(start),
    endSequence: String(start + 1),
    messages: [
      { id: `legacy-${start}`, sequence: String(start), role: 'user', parts: [textPart(text)] },
      { id: `legacy-${start + 1}`, sequence: String(start + 1), role: 'assistant', parts: [textPart('旧历史回复')] },
    ],
    terminal: true,
    outcome: null,
    legacy: true,
    block: 'legacy',
  };
}

export function budgets(overrides: Partial<MemoryBudgets> = {}): MemoryBudgets {
  return {
    enabled: true,
    contextTokens: 100000,
    recentTokens: 100000,
    summaryInputTokens: 100000,
    summaryOutputTokens: 2000,
    minNewTurns: 1,
    retryIntervalMs: 60000,
    ...overrides,
  };
}

export function endSequences(turns: readonly HistoryTurn[]): string[] {
  return turns.map(item => item.endSequence);
}
