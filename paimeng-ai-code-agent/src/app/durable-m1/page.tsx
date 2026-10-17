'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

type Frame = {
  pid: number;
  tasks: { kind: string; state: string }[];
  submissions: { id: number; status: string }[];
  view: { entries: { id: number; kind: string; text: string }[]; live: { text: string; tools: { name: string; status: string }[]; busy: boolean } };
};

const entryLabels: Record<string, string> = { 'pi.user': '我', 'pi.assistant': '模型', 'pi.tool-result': '工具结果', 'pi.system': '系统', 'pi.compaction': '压缩' };

/**
 * M1 迁移页：浏览器只连 Next.js 的 attach 通道，真正持有存储与任务的是常驻 harness 进程。
 * 刷新或断线重连都会从存储里读回完整转录（EventSource 自己会重连）。
 */
export default function DurableM1Page() {
  const [prompt, setPrompt] = useState('用 write 工具写一个 hello.txt，内容是一行 hello M1，然后回复一句完成');
  const [frame, setFrame] = useState<Frame | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [error, setError] = useState('');
  const source = useRef<EventSource | null>(null);

  const apply = useCallback((event: MessageEvent<string>) => {
    setFrame(JSON.parse(event.data) as Frame);
  }, []);

  const connect = useCallback(() => {
    source.current?.close();
    const es = new EventSource('/api/durable-m1/events');
    source.current = es;
    setConnection('connecting');
    es.addEventListener('snapshot', apply);
    es.addEventListener('revision', apply);
    es.onopen = () => setConnection('open');
    es.onerror = () => setConnection('closed');
  }, [apply]);

  useEffect(() => {
    connect();
    return () => source.current?.close();
  }, [connect]);

  async function send() {
    const content = prompt.trim();
    if (!content) return;
    setError('');
    // 提交不带任何 AbortSignal：断连只能断掉视图，不能取消任务。
    const response = await fetch('/api/durable-m1/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, requestId: `page-${Date.now()}` }) });
    if (!response.ok) setError(`提交失败：HTTP ${response.status}`);
    connect();
  }

  const busy = frame?.view.live.busy ?? false;
  const entries = (frame?.view.entries ?? []).filter((entry) => entry.kind !== 'pi.system' && entry.text.trim().length > 0);

  return <div className="page-container">
    <h2>M1 链路验证页</h2>
    <p>浏览器 → Next.js（attach 客户端）→ 常驻 harness 进程（唯一 writer）→ Postgres。</p>
    <p data-testid="m1-status">
      连接：{connection === 'open' ? '已连接' : connection === 'connecting' ? '连接中' : '已断开，浏览器会自动重连'} ·
      {busy ? ' 生成中' : ' 空闲'} · pid {frame?.pid ?? '-'} · 提交 {frame?.submissions.map((item) => `${item.id}:${item.status}`).join(',') || '无'}
    </p>
    <textarea aria-label="M1 输入" rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
    <div><button type="button" data-testid="m1-send" onClick={() => void send()} disabled={busy}>发送</button>{error ? <span role="alert"> {error}</span> : null}</div>
    <h3>转录</h3>
    <ol data-testid="m1-transcript">
      {entries.map((entry) => <li key={entry.id}><b>{entryLabels[entry.kind] ?? entry.kind}</b>：<pre>{entry.text}</pre></li>)}
    </ol>
    {frame?.view.live.text ? <p data-testid="m1-live"><b>生成中</b>：<pre>{frame.view.live.text}</pre></p> : null}
    {frame?.view.live.tools.length ? <p>工具：{frame.view.live.tools.map((tool) => `${tool.name}:${tool.status}`).join(' ')}</p> : null}
  </div>;
}
