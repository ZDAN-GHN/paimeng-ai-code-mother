'use client';
import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { MessageInstance } from 'antd/es/message/interface';
import { adoptPending, adoptTranscript, dropShownInputs, emptySentInputs, transcriptSignature, unresolvedInputs, type LostInput, type SentInputs } from '@/components/chat/chat-inputs';
import { settleProgress, type ProgressState } from '@/components/chat/generation-feedback';
import type { Generation } from '@/shared/contracts';
import type { ChatMessage, ChatRuntime } from '@/shared/chat-runtime';

/**
 * 生成同步域：本地输入队列（`inputs`）、待重发区（`lostInputs`）与运行态/任务终态如何汇入
 * 对话显示。页面只负责发起（`submit`、transport）与渲染，这里保证三份来源收敛到同一结果：
 * 运行态投影在本地没有流时是权威显示，任务终态一到就以转录为准重取并认领队列。
 *
 * `activeGenerationId` 由页面持有并传入：transport 在发送时写入 requestId，进度事件在
 * SSE 里读它，这里在收尾时核对是不是同一轮——它桥接的是 useChat 的两侧回调，必须在
 * useChat 之前声明，所以不能收进本 hook。
 */
export function useGenerationSync({
  task,
  status,
  stop,
  fetchHistory,
  fetchRuntime,
  liveRef,
  mounted,
  activeGenerationId,
  setMessages,
  setProgress,
  message,
}: {
  task: Generation | null;
  status: 'submitted' | 'streaming' | 'ready' | 'error';
  stop: () => Promise<void>;
  fetchHistory: () => Promise<ChatMessage[]>;
  fetchRuntime: () => Promise<ChatRuntime | null>;
  liveRef: RefObject<boolean>;
  mounted: RefObject<boolean>;
  activeGenerationId: RefObject<string | null>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setProgress: Dispatch<SetStateAction<ProgressState>>;
  message: MessageInstance;
}): {
  inputs: SentInputs;
  setInputs: Dispatch<SetStateAction<SentInputs>>;
  lostInputs: LostInput[];
  setLostInputs: Dispatch<SetStateAction<LostInput[]>>;
  awaitingHistory: boolean;
  runtimeBusy: boolean;
  applyRuntime: (runtime: ChatRuntime) => void;
  settledGenerations: RefObject<Set<string>>;
  shownMessageIds: RefObject<Set<string>>;
} {
  const [inputs, setInputs] = useState<SentInputs>(emptySentInputs);
  const [lostInputs, setLostInputs] = useState<LostInput[]>([]);
  const [awaitingHistory, setAwaitingHistory] = useState(false);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const inputsRef = useRef(inputs);
  const lostRef = useRef(lostInputs);
  const liveSignature = useRef('');
  const settledTask = useRef<string | null>(null);
  const settledGenerations = useRef(new Set<string>());
  const shownMessageIds = useRef(new Set<string>());

  /**
   * 应用一次运行态：补齐原生队列、认领已经进转录的输入。本地没有在流的消息时才用运行态投影替换显示
   * （断流或刷新后重新附着时它就是权威的进行中状态）；`liveSignature` 挡住内容没变的重复替换，
   * 否则每 1.5 秒会把整段转录重渲染一遍，也会打断用户自己发起的流式消息。
   */
  const applyRuntime = useCallback((runtime: ChatRuntime) => {
    setRuntimeBusy(runtime.busy);
    const shown = new Set(runtime.messages.map(message => message.id));
    // 待重发区里的输入后来还是进了对话（例如取消后服务端仍把它交给了模型）：转录接管它的显示。
    setLostInputs(current => {
      const kept = current.filter(item => !shown.has(item.id));
      return kept.length === current.length ? current : kept;
    });
    setMessages(current => {
      if (!runtime.busy || liveRef.current || !runtime.messages.length) return current;
      const signature = transcriptSignature(runtime.messages);
      if (signature === liveSignature.current) return current;
      liveSignature.current = signature;
      shownMessageIds.current = new Set(runtime.messages.map(message => message.id));
      return runtime.messages;
    });
    setInputs(current => {
      const recovered = adoptPending(current, runtime.pending, lostRef.current.map(item => item.id));
      // 没有本地流时运行态转录就是显示本身：它已经是权威，里面的用户条目由它渲染，
      // 本地再分段或停在末尾就会重复显示一条。
      if (runtime.busy && !liveRef.current && runtime.messages.length) return dropShownInputs(recovered, runtime.messages);
      // 还有本地流时不能提前删：分段层是这些输入的展示者，只把已进转录的从队列里认领出来。
      return adoptTranscript(recovered, runtime.messages);
    });
  }, [setMessages, liveRef]);
  /**
   * 任务终态统一收尾：终态可能来自终态进度事件，也可能只有轮询才能看到（连接被切断、用户主动取消）。
   * 终态对当前这一轮是权威的，所以本地流即使还挂着也先停掉，再按转录（权威）重取显示——断流后
   * 卡在「进行中」的工具卡片不会一直转圈。转录读不回来时不标记收尾（保留下一次重试），读回时也
   * 要重新核对是不是同一轮，否则旧响应会覆盖新开始的本地流。
   */
  useEffect(() => {
    // 刷新页面后也能等待现有任务结束；历史终态不属于本次生成，不能影响新队列。
    if (activeGenerationId.current === null && (task?.status === 'generating' || task?.status === 'building')) activeGenerationId.current = task.id;
    const terminal = task?.status === 'ready' || task?.status === 'failed' || task?.status === 'cancelled' ? task.status : null;
    if (!task || !terminal || task.id !== activeGenerationId.current || settledTask.current === task.id) return;
    const settling = task.id;
    setProgress(current => current.outcome === 'running' ? settleProgress(current, terminal) : current);
    setAwaitingHistory(true);
    void (async () => {
      if (status === 'submitted' || status === 'streaming') await stop();
      const history = await fetchHistory().catch(() => null);
      if (!mounted.current || !history) return;
      // pi 在模型失败后保留 inbox；仍在原生队列里的消息不能被当成丢失输入重新提交。
      const runtime = terminal === 'failed' ? await fetchRuntime() : null;
      if (!mounted.current || (terminal === 'failed' && !runtime)) return;
      // 读回期间又开始了新一轮（用户又发了一条）：这份历史已经过期，不能覆盖新的流。
      if (activeGenerationId.current !== settling) return;
      const authoritative = runtime?.messages ?? history;
      const pending = runtime?.pending ?? [];
      const pendingIds = new Set(pending.map(item => item.id));
      const lost = unresolvedInputs(inputsRef.current, authoritative).filter(item => !pendingIds.has(item.id));
      shownMessageIds.current = new Set(authoritative.map(message => message.id));
      if (!pending.length) settledGenerations.current.add(settling);
      setMessages(authoritative);
      liveSignature.current = transcriptSignature(authoritative);
      setInputs(adoptPending(emptySentInputs(), pending));
      settledTask.current = pending.length ? null : settling;
      setAwaitingHistory(pending.length > 0);
      if (!lost.length) return;
      message.warning(`${lost.length} 条输入没有进入对话，已放进输入框上方的待重发区`);
      setLostInputs(current => [...current, ...lost.filter(item => !current.some(entry => entry.id === item.id))]);
    })();
  }, [task, status, stop, fetchHistory, fetchRuntime, setMessages, message, activeGenerationId, setProgress, mounted]);
  // 异步收尾要读最新队列而不是渲染闭包里的旧值，所以镜像成 ref；效果在渲染后同步。
  useEffect(() => { inputsRef.current = inputs; }, [inputs]);
  useEffect(() => { lostRef.current = lostInputs; }, [lostInputs]);

  return {
    inputs,
    setInputs,
    lostInputs,
    setLostInputs,
    awaitingHistory,
    runtimeBusy,
    applyRuntime,
    settledGenerations,
    shownMessageIds,
  };
}
