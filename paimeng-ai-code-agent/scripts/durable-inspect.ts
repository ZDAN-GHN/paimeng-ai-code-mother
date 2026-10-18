/**
 * 会话检视：只读地看 harness 里某个会话的转录与运行状态。
 *
 *   npm run durable:inspect -- <conversationId> [--full]
 *   npm run durable:inspect -- --conversations
 *
 * 数据来自 harness 的 `/state` 与 `/messages`。转录按条目 id 升序打印，并给出 kind 计数：
 * 一眼能看出有没有重复的展示条目（历史上 `app.assistant` 就是产品自己写的重复层）。
 */
const base = (process.env.DURABLE_HARNESS_URL ?? `http://127.0.0.1:${process.env.DURABLE_HARNESS_PORT ?? '5599'}`).replace(/\/+$/, '');

type Entry = { id: number; kind: string; text: string };
type State = {
  pid?: number;
  scheduling?: string;
  tasks?: unknown[];
  submissions?: unknown[];
  view?: { entries?: Entry[] };
};

async function main(): Promise<void> {
const args = process.argv.slice(2);
const full = args.includes('--full');
const listOnly = args.includes('--conversations');
const conversationId = args.find(arg => /^\d+$/.test(arg));

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${base}${path}`);
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status} ${await response.text()}`);
  return await response.json() as T;
}

const preview = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 100 ? `${flat.slice(0, 100)}…` : flat;
};

try {
  if (listOnly) {
    const { conversations } = await get<{ conversations: unknown[] }>('/conversations');
    console.log(`harness ${base}`);
    console.log(JSON.stringify(conversations, null, 2));
  } else if (!conversationId) {
    console.error('用法：npm run durable:inspect -- <conversationId> [--full]  或  -- --conversations');
    process.exit(2);
  } else {
    const state = await get<State>(`/state?conversationId=${conversationId}`);
    const entries = [...(state.view?.entries ?? [])].sort((left, right) => left.id - right.id);
    const counts = new Map<string, number>();
    for (const entry of entries) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);

    console.log(`harness ${base}  pid=${state.pid ?? '-'}  scheduling=${state.scheduling ?? '-'}`);
    console.log(`tasks=${JSON.stringify(state.tasks ?? [])}  submissions=${JSON.stringify(state.submissions ?? [])}`);
    console.log(`条目 ${entries.length}：${[...counts].map(([kind, n]) => `${kind}×${n}`).join('  ')}`);
    console.log('---');
    for (const entry of entries) console.log(`${String(entry.id).padStart(5)}  ${entry.kind.padEnd(16)}  ${preview(entry.text)}`);

    if (full) {
      const { messages } = await get<{ messages: { id: number; kind: string; data?: { role?: string } }[] }>(`/messages?conversationId=${conversationId}`);
      console.log('--- /messages（前端读回的形状）---');
      for (const message of messages) console.log(`${String(message.id).padStart(5)}  ${message.kind.padEnd(16)}  ${message.data?.role ?? '-'}`);
    }
  }
} catch (problem) {
  console.error(`连不上 harness（${base}）：${problem instanceof Error ? problem.message : String(problem)}`);
  console.error('先起 harness：npm run durable:harness（或 npm run dev:durable）');
  process.exit(1);
}
}

void main();
