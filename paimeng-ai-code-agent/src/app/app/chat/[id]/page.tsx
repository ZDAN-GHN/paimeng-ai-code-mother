'use client';
import { use, useState, useEffect, useMemo, useRef, useCallback, type ComponentRef } from 'react';
import { useRouter } from 'next/navigation';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { App, Button, Input, Alert, Tag, Space, Spin, Tooltip } from 'antd';
import { SendOutlined, DownloadOutlined, CloudUploadOutlined, EditOutlined, StopOutlined, InfoCircleOutlined, ExportOutlined, PictureOutlined } from '@ant-design/icons';
import { api } from '@/client/api';
import { useAuth } from '@/components/providers';
import { type AppInfo, type Generation, type GenerationAccount, isProjectCodeGenType } from '@/shared/contracts';
import { imageLimits, type AttachmentPart } from '@/shared/attachments';
import { draggingFiles, filesFromClipboard, filesFromDrop } from '@/components/clipboard-images';
import { ImageAttachments, MessageImages, messageAttachments, outgoingParts, useImageAttachments } from '@/components/chat/image-attachments';
import { VoiceInput, appendTranscript } from '@/components/chat/voice-input';
import { MarkdownMessage } from '@/components/chat/markdown-message';
import { GenerationUsage } from '@/components/chat/generation-usage';
import { BuildProgress } from '@/components/chat/build-progress';
import { composerAction, dequeue, enqueue, initialProgress, interruptedStreamMessage, parseProgressEvent, progressReducer, removeQueued, settleProgress, type ProgressState } from '@/components/chat/generation-feedback';
import { ToolCall, toolCallOf } from '@/components/chat/tool-call';
import { AppDetailModal, formatCodeGenType } from '@/components/chat/app-detail-modal';
import { DeploySuccessModal } from '@/components/chat/deploy-success-modal';
import './chat.css';

type Selected = { selector: string; tagName: string; id: string; className: string; textContent: string; pagePath: string };
/**
 * SDK 的 `UIMessagePart` 联合里没有契约的 attachment part，所以附件只挂在消息 metadata 上：
 * 发送时由 transport 拼成 `{ type: 'attachment', … }` 发到服务端，本地回显与刷新后的历史都走
 * `messageAttachments` 这一条读取路径。
 */
type ChatMessage = UIMessage<{ attachments?: AttachmentPart[]; generationId?: string }>;
type QueuedMessage = { text: string; attachments: AttachmentPart[] };
const statusLabels = { generating: '生成中', building: '构建中', ready: '可预览', failed: '失败', cancelled: '已取消' } as const;
const historyPageSize = 10;
const inputLimit = 1000;

/** 服务端用 transient data 事件告知摘要进度；data 是未知形状，只在明确为 consolidating 时显示提示。 */
function isConsolidating(data: unknown): boolean {
  return typeof data === 'object' && data !== null && (data as { status?: unknown }).status === 'consolidating';
}

/** 服务端在构建失败后进入修复轮；data 是未知形状，只在阶段与次数都合法时显示提示。 */
function repairingOf(data: unknown): { attempt: number; maxAttempts: number } | null {
  if (typeof data !== 'object' || data === null) return null;
  const part = data as { status?: unknown; attempt?: unknown; maxAttempts?: unknown };
  return part.status === 'repairing' && typeof part.attempt === 'number' && typeof part.maxAttempts === 'number'
    ? { attempt: part.attempt, maxAttempts: part.maxAttempts }
    : null;
}

/** 助手回复的内容块：文字、思考过程、工具调用。工具调用只渲染可读信息，不显示原始 JSON。 */
function AssistantParts({ parts, assetUrl }: { parts: UIMessage['parts']; assetUrl: (path: string) => string }) {
  return <>{parts.map((part, index) => {
    if (part.type === 'text') return <MarkdownMessage key={index} content={part.text} />;
    if (part.type === 'reasoning') return <details className="reasoning" key={index}><summary>思考过程</summary><div className="message-text">{part.text}</div></details>;
    const call = toolCallOf(part);
    return call ? <ToolCall key={index} call={call} assetUrl={assetUrl} /> : null;
  })}</>;
}

function selectionContext(selected: Selected) {
  const lines = ['\n\n选中元素信息：'];
  if (selected.pagePath) lines.push('- 页面路径: ' + selected.pagePath);
  lines.push('- 标签: ' + selected.tagName.toLowerCase());
  lines.push('- 选择器: ' + selected.selector);
  if (selected.id) lines.push('- ID: ' + selected.id);
  if (selected.className) lines.push('- class: ' + selected.className);
  if (selected.textContent) lines.push('- 当前内容: ' + selected.textContent.slice(0, 100));
  return lines.join('\n');
}

export default function AppChat({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Chat key={id} id={id} />;
}

function Chat({ id }: { id: string }) {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const { message } = App.useApp();
  const [app, setApp] = useState<AppInfo | null>(null);
  const [input, setInput] = useState('');
  const [task, setTask] = useState<Generation | null>(null);
  const [usageByMessage, setUsageByMessage] = useState<Map<string, GenerationAccount>>(new Map());
  const [error, setError] = useState('');
  const [dismissedTaskError, setDismissedTaskError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [appLoaded, setAppLoaded] = useState(false);
  const [historySettled, setHistorySettled] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [busySeconds, setBusySeconds] = useState(0);
  const [repairing, setRepairing] = useState<{ attempt: number; maxAttempts: number } | null>(null);
  const [visibleHistory, setVisibleHistory] = useState(historyPageSize);
  const [stickToBottom, setStickToBottom] = useState(true);
  const [detailOpen, setDetailOpen] = useState(false);
  const [deployModal, setDeployModal] = useState<{ open: boolean; url: string }>({ open: false, url: '' });
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [progress, setProgress] = useState<ProgressState>(initialProgress);
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [dragging, setDragging] = useState(false);
  const [queuePaused, setQueuePaused] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [drainArmed, setDrainArmed] = useState(false);
  const [sending, setSending] = useState(false);
  const [steered, setSteered] = useState(false);
  const [previewVersion, setPreviewVersion] = useState<number | null>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  const messageList = useRef<HTMLDivElement>(null);
  const messageContent = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const followedScrollTop = useRef(0);
  const mounted = useRef(false);
  const submitting = useRef(false);
  const rebuildCount = useRef(0);
  const rebuildAt = useRef(0);
  const rebuildTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialPromptHandled = useRef(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const voiceInput = useRef<ComponentRef<typeof Input.TextArea>>(null);
  const loadingOlder = useRef(false);
  const activeGenerationId = useRef<string | null>(null);
  const settledTask = useRef<string | null>(null);
  const previewRefreshAt = useRef(0);
  const previewPending = useRef<number | null>(null);
  const canEdit = !!user && user.id === app?.userId;
  const isAdmin = user?.userRole === 'admin';
  const loaded = appLoaded && historySettled;
  const canAttachImages = canEdit && loaded;
  const { drafts: imageDrafts, parts: imageParts, blockReason: imageBlockReason, add: addImages, remove: removeImage, retry: retryImage, clearSent: clearSentImages } = useImageAttachments(id);
  // 转写别名是否配置由服务端回答（需要登录）：未配置时麦克风禁用并说明，不假装可用。
  useEffect(() => {
    if (!canEdit) return;
    let active = true;
    api<{ enabled: boolean }>('app/chat/transcribe')
      .then(result => { if (active) setVoiceEnabled(result.enabled); })
      .catch(() => { if (active) setVoiceEnabled(false); });
    return () => { active = false; };
  }, [canEdit]);
  /** 转写结果追加到已有输入后面（不自动发送），渲染落地后把光标放到末尾，用户可以直接接着写。 */
  const appendVoiceText = useCallback((text: string) => {
    setInput(current => appendTranscript(current, text));
    requestAnimationFrame(() => {
      const element = voiceInput.current?.resizableTextArea?.textArea;
      if (!element) return;
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
    });
  }, []);

  const refresh = useCallback(async () => {
    const [info, generation] = await Promise.allSettled([
      api<AppInfo>('app/get/vo?id=' + encodeURIComponent(id)),
      api<Generation | null>('app/generation?appId=' + encodeURIComponent(id)),
    ]);
    if (!mounted.current) return null;
    if (info.status === 'fulfilled') setApp(info.value);
    const fresh = generation.status === 'fulfilled' ? generation.value : null;
    if (generation.status === 'fulfilled') setTask(generation.value);
    return fresh;
  }, [id]);
  const transport = useMemo(() => new DefaultChatTransport<ChatMessage>({
    api: '/api/app/chat/gen/code',
    // 本地回显挂在 metadata 上的附件在这里变成契约的 attachment part；排队消息自动发送走的是同一条路。
    prepareSendMessagesRequest: ({ messages }) => {
      const requestId = crypto.randomUUID();
      activeGenerationId.current = requestId;
      const message = messages[messages.length - 1];
      return { body: { appId: id, message: { ...message, parts: outgoingParts(message) }, requestId } };
    },
  }), [id]);
  /** 消费服务端的瞬时 `data-progress`：推进时间线、按 >=1s 节流刷新 iframe、终态接管队列。 */
  function applyProgress(data: unknown) {
    const event = parseProgressEvent(data);
    if (!event) return;
    setProgress(current => progressReducer(current, event));
    if (event.stage === 'preview') {
      previewPending.current = event.version;
      if (Date.now() - previewRefreshAt.current >= 1000) {
        previewRefreshAt.current = Date.now();
        previewPending.current = null;
        setPreviewVersion(event.version);
      }
      return;
    }
    if (event.stage === 'ready' || event.stage === 'failed' || event.stage === 'cancelled') {
      const pending = previewPending.current;
      previewPending.current = null;
      if (pending !== null) { previewRefreshAt.current = Date.now(); setPreviewVersion(pending); }
      if (event.stage === 'cancelled') setQueuePaused(true);
      else { setTask(current => current ? { ...current, id: activeGenerationId.current ?? current.id, status: event.stage } : current); setDrainArmed(true); }
    }
  }
  const { messages, setMessages, sendMessage, stop, clearError, status, error: chatError } = useChat<ChatMessage>({
    id, transport,
    // 流结束只重新取任务状态：断流后任务可能仍在跑，这里不乐观标 ready，统一由下面的终态收尾。
    onFinish: async () => { await refresh(); },
    onError: e => { if (mounted.current) setError(e.message); },
    onData: part => {
      if (part.type === 'data-memory') setMemoryBusy(isConsolidating(part.data));
      if (part.type === 'data-build') setRepairing(repairingOf(part.data));
      if (part.type === 'data-progress') applyProgress(part.data);
    },
  });
  const generating = status === 'submitted' || status === 'streaming' || task?.status === 'generating' || task?.status === 'building';
  const loadHistory = useCallback(async (): Promise<ChatMessage[]> => {
    const history = await api<ChatMessage[]>('app/messages?appId=' + encodeURIComponent(id));
    if (mounted.current) setMessages(history);
    return history;
  }, [id, setMessages]);
  /**
   * 任务终态统一收尾时间线与队列：终态可能来自终态进度事件，也可能只有轮询才能看到
   * （连接被切断、用户主动取消）。流还在跑时不收尾，避免上一轮的终态覆盖刚开始的新一轮。
   */
  useEffect(() => {
    // 刷新页面后也能等待现有任务结束；历史终态不属于本次生成，不能影响新队列。
    if (activeGenerationId.current === null && (task?.status === 'generating' || task?.status === 'building')) activeGenerationId.current = task.id;
    if (status === 'submitted' || status === 'streaming') return;
    const terminal = task?.status === 'ready' || task?.status === 'failed' || task?.status === 'cancelled' ? task.status : null;
    if (!task || !terminal || task.id !== activeGenerationId.current || settledTask.current === task.id) return;
    settledTask.current = task.id;
    setProgress(current => current.outcome === 'running' ? settleProgress(current, terminal) : current);
    if (terminal === 'cancelled') setQueuePaused(true);
    else setDrainArmed(true);
  }, [task, status]);
  const taskStatus = task?.status;
  // 每次生成结束时取一次用量：一条助手回复对应一次生成，按消息 id 挂到气泡上；生成中不轮询明细。
  const assetUrl = useCallback((path: string) => '/api/app/asset?appId=' + encodeURIComponent(id) + '&path=' + encodeURIComponent(path), [id]);
  const refreshUsage = useCallback(async () => {
    try {
      const accounts = await api<GenerationAccount[]>('app/generation/accounts?appId=' + encodeURIComponent(id));
      if (!mounted.current) return;
      setUsageByMessage(new Map(accounts.flatMap(account => [
        [account.generationId, account] as [string, GenerationAccount],
        ...(account.messageId ? [[account.messageId, account] as [string, GenerationAccount]] : []),
      ])));
    } catch { if (mounted.current) setUsageByMessage(new Map()); }
  }, [id]);
  useEffect(() => {
    if (!task?.id || taskStatus === 'generating' || taskStatus === 'building') return;
    void refreshUsage();
  }, [task?.id, taskStatus, refreshUsage]);
  useEffect(() => { if (!generating) { setMemoryBusy(false); setRepairing(null); setSteered(false); } }, [generating]);
  const buildPending = publishing || rebuilding;
  useEffect(() => {
    if (!buildPending) { setBusySeconds(0); return; }
    const timer = setInterval(() => setBusySeconds(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, [buildPending]);

  useEffect(() => {
    mounted.current = true;
    let live = true;
    void (async () => {
      let info: AppInfo;
      try {
        info = await api<AppInfo>('app/get/vo?id=' + encodeURIComponent(id));
      } catch (e) {
        if (live) setError((e as Error).message);
        return;
      }
      if (!live) return;
      setApp(info);
      setAppLoaded(true);
      try {
        const [history, generation] = await Promise.all([
          loadHistory(),
          api<Generation | null>('app/generation?appId=' + encodeURIComponent(id)),
        ]);
        if (!live) return;
        setTask(generation);
        setHistoryLoaded(true);
        if (!history.length) setInput(current => current || info.initPrompt);
      } catch (e) {
        if (!live) return;
        setHistoryError((e as Error).message);
        setInput(current => current || info.initPrompt);
      } finally {
        if (live) setHistorySettled(true);
      }
    })();
    return () => { live = false; mounted.current = false; if (rebuildTimer.current) clearTimeout(rebuildTimer.current); void stop(); };
  }, [id, setMessages, stop]);

  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(() => { void refresh(); }, 1500);
    return () => clearInterval(timer);
  }, [generating, refresh]);
  // 流式追加只在用户本来就贴着底部时才跟随；用户向上看历史时不动他的滚动位置。
  const scrollToBottom = useCallback((smooth = false) => {
    const list = messageList.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    followedScrollTop.current = list.scrollTop;
    stick.current = true;
    setStickToBottom(true);
  }, []);
  const onMessagesScroll = useCallback(() => {
    const list = messageList.current;
    if (!list) return;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    stick.current = atBottom;
    if (atBottom) followedScrollTop.current = list.scrollTop;
    setStickToBottom(atBottom);
  }, []);
  const followNewContent = useCallback(() => {
    const list = messageList.current;
    if (!list || !stick.current) return;
    if (list.scrollTop < followedScrollTop.current - 1) {
      stick.current = false;
      setStickToBottom(false);
      return;
    }
    list.scrollTop = list.scrollHeight;
    followedScrollTop.current = list.scrollTop;
  }, []);
  useEffect(() => {
    if (loadingOlder.current) { loadingOlder.current = false; return; }
    followNewContent();
  }, [messages, visibleHistory, followNewContent]);
  // 内容长高时（流式文字、图片缩略图加载、用量块出现）保持贴底；用户向上翻历史后不再强制滚动。
  useEffect(() => {
    const content = messageContent.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(followNewContent);
    observer.observe(content);
    return () => observer.disconnect();
  }, [followNewContent]);

  const previewOrigin = app?.previewUrl ? new URL(app.previewUrl).origin : null;
  // iframe 加载完成前它的文档还是 about:blank（源继承自本页），此时向预览源发消息会被浏览器拒绝并报错。
  const previewLoaded = useRef(false);
  const editorMessage = useCallback((value: Record<string, unknown>) => {
    if (!previewLoaded.current || !previewOrigin) return;
    iframe.current?.contentWindow?.postMessage(value, previewOrigin);
  }, [previewOrigin]);
  useEffect(() => { previewLoaded.current = false; }, [app?.previewUrl, task?.id]);
  useEffect(() => {
    editorMessage({ type: 'TOGGLE_EDIT_MODE', editMode: editing });
    if (editing) return;
    setSelected(null);
    editorMessage({ type: 'CLEAR_ALL_EFFECTS' });
  }, [editing, editorMessage]);
  useEffect(() => {
    function receive(event: MessageEvent) {
      if (!previewOrigin || event.origin !== previewOrigin || event.source !== iframe.current?.contentWindow ||
          !event.data || typeof event.data !== 'object') return;
      if (event.data.type === 'EDITOR_READY') { editorMessage({ type: 'TOGGLE_EDIT_MODE', editMode: editing }); return; }
      const info = (event.data as { elementInfo?: Record<string, unknown> }).elementInfo;
      if (editing && canEdit && event.data.type === 'ELEMENT_SELECTED' && info &&
          typeof info.selector === 'string' && info.selector.length > 0 && info.selector.length <= 512 &&
          typeof info.tagName === 'string' && info.tagName.length > 0 && info.tagName.length <= 64 &&
          typeof info.textContent === 'string' && typeof info.id === 'string' && info.id.length <= 256 &&
          typeof info.className === 'string' && info.className.length <= 512 &&
          typeof info.pagePath === 'string' && info.pagePath.length <= 512) {
        setSelected({
          selector: info.selector, tagName: info.tagName, id: info.id, className: info.className,
          pagePath: info.pagePath, textContent: info.textContent.slice(0, 2000),
        });
      }
    }
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [previewOrigin, editing, canEdit, editorMessage]);

  // 粘贴附图：只要还能编辑就监听（生成中也要能附图，排队发送会带上它）；没有文件时不插手粘贴。
  useEffect(() => {
    if (!canAttachImages) return;
    function receive(event: ClipboardEvent) {
      const files = filesFromClipboard(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      addImages(files);
    }
    window.addEventListener('paste', receive);
    return () => window.removeEventListener('paste', receive);
  }, [canAttachImages, addImages]);

  const submit = useCallback(async (original: string, attachments: readonly AttachmentPart[] = []) => {
    if (!original.trim() || generating || submitting.current || !canEdit || !loaded) return;
    if (imageBlockReason) { message.warning(imageBlockReason); return; }
    const context = selected ? selectionContext(selected) : '';
    const text = original.trim() + context;
    if (text.length > inputLimit) { setError('消息与选中元素信息合计不能超过 1000 字，请精简后重试'); return; }
    initialPromptHandled.current = true;
    submitting.current = true;
    setSending(true);
    stick.current = true;
    previewPending.current = null;
    previewRefreshAt.current = 0;
    setStickToBottom(true);
    setProgress(initialProgress());
    setPreviewVersion(null);
    setSteered(false);
    setDrainArmed(false);
    setError(''); clearError(); setDismissedTaskError(''); setInput(''); setSelected(null); setEditing(false); clearSentImages(attachments);
    try {
      await sendMessage({ text, metadata: attachments.length ? { attachments: [...attachments] } : undefined });
      await refresh();
    } catch (e) {
      if (mounted.current) {
        setInput(original);
        setError((e as Error).message);
        if (attachments.length) message.warning('图片未随消息发出，请重新添加');
      }
    } finally { submitting.current = false; setSending(false); }
  }, [generating, canEdit, loaded, selected, clearError, sendMessage, refresh, imageBlockReason, clearSentImages, message]);

  /** 生成中按 Enter：本地排队，等终态事件（或 onFinish 兜底）后自动发队首；附件跟着队首一起发。 */
  const queueMessage = useCallback(() => {
    const text = input.trim();
    if (!text || !canEdit || !loaded) return;
    if (imageBlockReason) { message.warning(imageBlockReason); return; }
    setQueue(current => enqueue(current, { text, attachments: [...imageParts] }));
    setInput('');
    clearSentImages(imageParts);
  }, [input, canEdit, loaded, imageBlockReason, imageParts, clearSentImages, message]);

  /** 生成中按 Ctrl/⌘ + Enter：注入模型上下文，这条消息立即出现在对话里。 */
  const steer = useCallback(async () => {
    const text = input.trim();
    if (!text || !canEdit || !loaded) return;
    try {
      await api('app/chat/steer', { appId: id, text });
      if (!mounted.current) return;
      setInput('');
      setSteered(true);
      setMessages(previous => {
        const message: ChatMessage = { id: 'steer-' + crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] };
        const lastAssistant = previous.findLastIndex(item => item.role === 'assistant');
        return lastAssistant < 0 ? [...previous, message] : [...previous.slice(0, lastAssistant), message, ...previous.slice(lastAssistant)];
      });
    } catch (e) {
      if (mounted.current) message.error((e as Error).message);
    }
  }, [input, canEdit, loaded, id, setMessages, message]);

  // 终态后把队首发出去；暂停（取消）时不发，等用户点「继续发送」。sendMessage 要等整条流结束
  // 才 settle，所以用 sending 状态等上一次发送彻底结束，否则队首会被 submitting 拦掉。
  useEffect(() => {
    if (!drainArmed || generating || queuePaused || sending || !canEdit || !loaded) return;
    const { head, rest } = dequeue(queue);
    if (head === null) return;
    setDrainArmed(false);
    setQueue(rest);
    void submit(head.text, head.attachments);
  }, [drainArmed, generating, queuePaused, sending, queue, canEdit, loaded, submit]);

  useEffect(() => {
    if (!appLoaded || !historyLoaded || authLoading || !app || initialPromptHandled.current) return;
    initialPromptHandled.current = true;
    if (canEdit && !messages.length && !task && !generating && app.initPrompt.trim()) void submit(app.initPrompt);
  }, [appLoaded, historyLoaded, authLoading, app, canEdit, messages.length, task, generating, submit]);

  useEffect(() => {
    if (!appLoaded || !canEdit || !app || generating || rebuilding || rebuildCount.current >= 6) return;
    if (app.previewUrl || app.sourceAvailable !== true || !isProjectCodeGenType(app.codeGenType)) return;
    if (!task && !messages.length) return;
    if (Date.now() - rebuildAt.current < 3000) return;
    rebuildAt.current = Date.now(); rebuildCount.current += 1;
    setRebuilding(true);
    void (async () => {
      let retry = false;
      try { retry = !(await api<string | null>('app/build', { appId: id })); }
      catch (e) { if (mounted.current) message.error((e as Error).message); }
      finally { if (mounted.current) setRebuilding(false); await refresh(); }
      if (retry && mounted.current) rebuildTimer.current = setTimeout(() => { void refresh(); }, 5000);
    })();
  }, [appLoaded, canEdit, app, generating, rebuilding, task, messages.length, id, message, refresh]);

  async function cancel() {
    setCancelling(true);
    if (queue.length) setQueuePaused(true);
    try {
      await api('app/generation/cancel', { appId: id });
      await stop(); await refresh();
    } catch (e) { message.error((e as Error).message); }
    finally { if (mounted.current) setCancelling(false); }
  }
  async function deploy() {
    setPublishing(true);
    try {
      const url = await api<string>('app/deploy', { appId: id });
      setDeployModal({ open: true, url });
      message.success('部署成功');
      await refresh();
    } catch (e) { message.error((e as Error).message); }
    finally { if (mounted.current) setPublishing(false); }
  }
  async function removeApp() {
    try {
      await api('app/delete', { id });
      message.success('应用已删除');
      setDetailOpen(false);
      router.push('/');
    } catch (e) { message.error((e as Error).message); }
  }

  const taskErrorKey = task?.error ? `${task.id}:${task.error}` : '';
  // 失败之后又成功构建（builtAt）或部署（deployedTime）过，这条失败已不代表当前状态。
  const failureTime = task?.updateTime ?? '';
  const failureResolved = !!failureTime && [app?.builtAt, app?.deployedTime].some(time => !!time && time > failureTime);
  const building = task?.status === 'building';
  const visibleMessages = messages.slice(-visibleHistory);
  const sourceAvailable = app?.sourceAvailable ?? !!app?.previewUrl;
  const canPreview = !!app?.previewUrl;
  const rawRequestError = error || chatError?.message || null;
  // 响应流被浏览器/网络层切断时的原文（如 `Error in input stream`）换成可读文案。
  const interrupted = rawRequestError ? interruptedStreamMessage({ message: rawRequestError, status: task?.status ?? null }) : null;
  const requestError = interrupted ? null : rawRequestError;
  const taskError = !failureResolved && taskErrorKey !== dismissedTaskError ? task?.error ?? null : null;
  const alert = interrupted
    ? { type: 'warning' as const, title: interrupted, dismiss: () => { setError(''); clearError(); } }
    : requestError
    ? { type: 'error' as const, title: requestError, dismiss: () => { setError(''); clearError(); } }
    : taskError
      ? canPreview
        ? { type: 'warning' as const, title: `上次生成失败：${taskError}。当前预览由已有代码构建，可以直接预览、编辑或部署；重新发送需求可继续修复。`, dismiss: () => { setDismissedTaskError(taskErrorKey); } }
        : { type: 'error' as const, title: taskError, dismiss: () => { setDismissedTaskError(taskErrorKey); } }
      : null;
  const taskRunning = task?.status === 'generating' || task?.status === 'building';
  const statusLabel = task ? (taskRunning ? statusLabels[task.status] : canPreview ? statusLabels.ready : statusLabels[task.status]) : null;
  const statusColor = statusLabel === statusLabels.ready ? 'green' : statusLabel === statusLabels.failed ? 'red' : 'default';
  const canDownload = canEdit && sourceAvailable && !generating;
  const canDeploy = canEdit && (canPreview || sourceAvailable) && !generating;
  const contextLength = selected ? selectionContext(selected).length : 0;
  const textareaMax = Math.max(0, inputLimit - contextLength);
  const previewSrc = canPreview && app?.previewUrl
    ? app.previewUrl + (app.previewUrl.includes('?') ? '&' : '?') + 'generation=' + encodeURIComponent(task?.id || '') + (previewVersion === null ? '' : '&pv=' + previewVersion)
    : undefined;

  return <main className="chat-page">
    <div className="chat-toolbar">
      <h1 className="chat-app-name">{app?.appName || '网站生成器'}</h1>
      {app?.codeGenType && <Tag color="blue">{formatCodeGenType(app.codeGenType)}</Tag>}
      {task && statusLabel && <Tag color={statusColor}>{statusLabel}</Tag>}
      <Space wrap>
        <Button icon={<InfoCircleOutlined aria-hidden="true" />} disabled={!app} onClick={() => setDetailOpen(true)}>应用详情</Button>
        <Button href={canEdit ? '/app/edit/' + id : undefined} icon={<EditOutlined aria-hidden="true" />} disabled={!canEdit}>编辑应用</Button>
        <Button href={canDownload ? '/api/app/download/' + encodeURIComponent(id) : undefined} icon={<DownloadOutlined aria-hidden="true" />} disabled={!canDownload}>下载代码</Button>
        <Button type="primary" icon={<CloudUploadOutlined aria-hidden="true" />} loading={publishing} disabled={!canDeploy} onClick={() => { void deploy(); }}>{publishing ? '部署中…' : '部署'}</Button>
      </Space>
    </div>
    {alert && <Alert style={{ marginBottom: 12 }} type={alert.type} title={alert.title} closable={{ 'aria-label': '关闭错误提示' }} onClose={alert.dismiss} />}
    {buildPending && <Alert style={{ marginBottom: 12 }} type="info" title={publishing ? `正在部署：容器内安装依赖并打包，已用时 ${busySeconds} 秒（通常 1-5 分钟），完成后会弹出部署链接` : `正在构建预览：容器内安装依赖并打包，已用时 ${busySeconds} 秒（通常 1-5 分钟）`} />}
    {historyError && <Alert style={{ marginBottom: 12 }} type="warning" title={'对话历史暂不可读取：' + historyError} />}
    <div className="chat-columns">
      <section className="chat-panel" aria-label="应用对话">
        <div className="messages" ref={messageList} onScroll={onMessagesScroll}>
          <div className="messages-inner" ref={messageContent}>
            {messages.length > visibleHistory && <Button type="link" onClick={() => { loadingOlder.current = true; setVisibleHistory(count => count + historyPageSize); }}>加载更多历史消息</Button>}
            {!messages.length && <div className="message-item initial-prompt"><div className="message-role">初始需求</div><div className="message-text">{app?.initPrompt || '加载应用…'}</div></div>}
            {visibleMessages.map(item => {
              const usage = usageByMessage.get(item.id) ?? (item.metadata?.generationId ? usageByMessage.get(item.metadata.generationId) : undefined);
              return item.role === 'user'
                ? <div className="message-item message-user" key={item.id}>
                    <div className="message-bubble">
                      <MessageImages appId={id} attachments={messageAttachments(item)} />
                      {item.parts.map((part, index) => part.type === 'text' ? <div className="message-text" key={index}>{part.text}</div> : null)}
                    </div>
                  </div>
                : <div className="message-item message-ai" key={item.id}>
                    <div className="message-bubble"><AssistantParts parts={item.parts} assetUrl={assetUrl} />{usage && <GenerationUsage usage={usage} />}</div>
                  </div>;
            })}
          </div>
        </div>
        {!stickToBottom && <button type="button" className="jump-to-bottom" onClick={() => scrollToBottom(true)}>回到最新 ↓</button>}
        {memoryBusy && <p className="memory-hint" role="status">正在整理历史上下文，请稍候…</p>}
        <BuildProgress state={progress} error={taskError} />
        {generating && <p className="generating-hint" role="status">{repairing ? '构建未通过，正在进行第 ' + repairing.attempt + '/' + repairing.maxAttempts + ' 次修复…' : steered ? '已插话，模型会在当前步骤结束后处理' : '正在生成或构建，请稍候…'}</p>}
        <div className="chat-input" style={dragging ? { outline: '2px dashed #cb573e', outlineOffset: -4 } : undefined}
          onDragOver={event => { if (!canAttachImages || !draggingFiles(event.dataTransfer)) return; event.preventDefault(); if (!dragging) setDragging(true); }}
          onDragLeave={event => { if (!canAttachImages) return; const target = event.relatedTarget instanceof Node ? event.relatedTarget : null; if (!event.currentTarget.contains(target)) setDragging(false); }}
          onDrop={event => { if (!canAttachImages || !draggingFiles(event.dataTransfer)) return; event.preventDefault(); setDragging(false); addImages(filesFromDrop(event.dataTransfer)); }}>
          {dragging && <p className="composer-hint" role="status" style={{ marginBottom: 8 }}>松开鼠标即可添加图片（JPEG / PNG / WebP，最多 {imageLimits.maxImages} 张）</p>}
          {queue.length > 0 && <div className="composer-queue">
            <span className="composer-queue-hint" role="status">{queue.length} 条消息排队中</span>
            <div className="composer-queue-chips">
              {queue.map((item, index) => <Tag key={index} className="composer-queue-chip" closable onClose={() => setQueue(current => removeQueued(current, index))}>{item.text}{item.attachments.length ? ` · ${item.attachments.length} 张图` : ''}</Tag>)}
            </div>
          </div>}
          {queuePaused && queue.length > 0 && <div className="composer-queue-paused">
            <span>已停止，队列已暂停</span>
            <Button size="small" type="link" onClick={() => { setQueuePaused(false); setDrainArmed(true); }}>继续发送</Button>
          </div>}
          {selected && <Alert className="selected-element-alert" type="info" closable onClose={() => setSelected(null)}
            title={'已选中 ' + selected.tagName.toLowerCase() + (selected.id ? ' #' + selected.id : '') + (selected.className ? ' .' + selected.className.split(/\s+/).filter(Boolean).join('.') : '')}
            description={<div className="element-details">
              {selected.pagePath && <div className="element-item">页面路径: {selected.pagePath}</div>}
              <div className="element-item">选择器: <code className="element-selector-code">{selected.selector}</code></div>
              {selected.textContent && <div className="element-item">内容: {selected.textContent.slice(0, 50)}{selected.textContent.length > 50 ? '…' : ''}</div>}
            </div>} />}
          <ImageAttachments appId={id} drafts={imageDrafts} onRemove={removeImage} onRetry={retryImage} />
          {/* 键盘提示固定显示在输入框右下角（绝对定位，不参与布局，所以不会像真实文字那样把按钮行撑出面板），
              文案随状态切换：未生成时 Enter 是直接发送，生成中 Enter 是排队。 */}
          <div className="composer-field">
            <Input.TextArea aria-label="对话消息" ref={voiceInput} placeholder={canEdit ? '请描述你想生成的网站，越详细效果越好哦' : '无法在别人的作品下对话哦~'} value={input}
              onChange={e => setInput(e.target.value)} disabled={!canEdit || !loaded} autoSize={{ minRows: 3, maxRows: 6 }} maxLength={textareaMax}
              onKeyDown={e => {
                if (e.nativeEvent.isComposing) return;
                const action = composerAction({ key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, generating });
                if (action === 'none' || action === 'newline') return;
                e.preventDefault();
                if (action === 'send') void submit(input, imageParts);
                else if (action === 'queue') queueMessage();
                else if (imageDrafts.length) message.warning('插话只支持文字，等本轮结束再附图');
                else void steer();
              }} />
            <span className="composer-keys">{canEdit ? (generating ? 'Enter 排队发送 · Ctrl + Enter 中途插话 · Shift + Enter 换行' : 'Enter 直接发送 · Ctrl + Enter 中途插话 · Shift + Enter 换行') : ''}</span>
          </div>
          <input ref={imageInput} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden
            onChange={event => { addImages(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ''; }} />
          <div className="prompt-actions">
            <Space wrap>
              <Button size="small" icon={<PictureOutlined aria-hidden="true" />} aria-label="添加图片" disabled={!canAttachImages || imageDrafts.length >= imageLimits.maxImages} onClick={() => imageInput.current?.click()}>添加图片</Button>
              <VoiceInput editable={canEdit && loaded} serverEnabled={voiceEnabled} onTranscript={appendVoiceText} />
              {generating ? <Button danger icon={<StopOutlined aria-hidden="true" />} loading={cancelling} disabled={building} title={building ? '代码已生成，正在完成构建，构建无法取消' : undefined} onClick={() => { void cancel(); }}>{building ? '构建中' : '停止生成'}</Button> :
                /* 附图状态挡住发送时，原因走悬浮提示：常显的长文案会把按钮行撑到面板外被裁掉。
                   提示挂在 span 上，因为禁用的原生按钮不派发鼠标事件，直接挂在按钮上悬停不出提示。 */
                <Tooltip title={imageBlockReason}>
                  <span><Button type="primary" icon={<SendOutlined aria-hidden="true" />} disabled={!canEdit || !loaded || !input.trim() || imageBlockReason !== null} onClick={() => { void submit(input, imageParts); }}>发送</Button></span>
                </Tooltip>}
            </Space>
          </div>
        </div>
      </section>
      <section className="preview-panel">
        <div className="preview-bar"><h3>生成后的网页展示</h3><Space>
          {canPreview && <Button size="small" type="link" danger={editing} disabled={!canEdit || generating} onClick={() => setEditing(value => !value)}>{editing ? '退出编辑' : '可视化编辑'}</Button>}
          {canPreview && <Button size="small" type="link" icon={<ExportOutlined aria-hidden="true" />} onClick={() => { if (app?.previewUrl) window.open(app.previewUrl, '_blank', 'noopener'); }}>新窗口打开</Button>}
          {app?.deployUrl && <a href={app.deployUrl} target="_blank" rel="noopener noreferrer">访问作品</a>}
        </Space></div>
        {canPreview ? <div className="preview-live">
          {generating && <div className="preview-live-badge" role="status">生成中，内容会持续更新</div>}
          <iframe ref={iframe} className="preview-frame" title="应用预览" src={previewSrc} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" onLoad={() => { previewLoaded.current = true; editorMessage({ type: 'TOGGLE_EDIT_MODE', editMode: editing }); }} />
        </div> :
          generating || rebuilding ? <div className="preview-loading" role="status"><Spin size="large" /><p>{generating ? '正在生成网站...' : '正在重建预览...'}</p></div> :
          <div className="preview-placeholder"><div className="preview-placeholder-icon">🌐</div><p>网站文件生成完成后将在这里展示</p></div>}
      </section>
    </div>
    <AppDetailModal open={detailOpen} app={app} showActions={canEdit || !!isAdmin} onClose={() => setDetailOpen(false)}
      onEdit={() => { setDetailOpen(false); router.push('/app/edit/' + id); }} onDelete={() => { void removeApp(); }} />
    <DeploySuccessModal open={deployModal.open} deployUrl={deployModal.url} onClose={() => setDeployModal(current => ({ ...current, open: false }))}
      onOpenSite={() => { if (deployModal.url) window.open(deployModal.url, '_blank', 'noopener'); }} />
  </main>;
}
