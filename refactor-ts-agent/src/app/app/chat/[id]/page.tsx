'use client';
import { use, useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { App, Button, Input, Alert, Tag, Space } from 'antd';
import { SendOutlined, DownloadOutlined, CloudUploadOutlined, EditOutlined, StopOutlined } from '@ant-design/icons';
import { api } from '@/client/api';
import { useAuth } from '@/components/providers';
import type { AppInfo, Generation } from '@/shared/contracts';

type Selected = { selector: string; tagName: string; textContent: string };
const statusLabels = { generating: '生成中', building: '构建中', ready: '可预览', failed: '失败', cancelled: '已取消' } as const;
const historyPageSize = 10;

export default function AppChat({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Chat key={id} id={id} />;
}

function Chat({ id }: { id: string }) {
  const { user } = useAuth();
  const { message } = App.useApp();
  const [app, setApp] = useState<AppInfo | null>(null);
  const [input, setInput] = useState('');
  const [task, setTask] = useState<Generation | null>(null);
  const [error, setError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [visibleHistory, setVisibleHistory] = useState(historyPageSize);
  const iframe = useRef<HTMLIFrameElement>(null);
  const messageList = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const submitting = useRef(false);
  const loadingOlder = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const [info, generation] = await Promise.all([
        api<AppInfo>('app/get/vo?id=' + encodeURIComponent(id)),
        api<Generation | null>('app/generation?appId=' + encodeURIComponent(id)),
      ]);
      if (mounted.current) { setApp(info); setTask(generation); }
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    }
  }, [id]);
  const transport = useMemo(() => new DefaultChatTransport({
    api: '/api/app/chat/gen/code',
    prepareSendMessagesRequest: ({ messages }) => ({
      body: { appId: id, message: messages[messages.length - 1], requestId: crypto.randomUUID() },
    }),
  }), [id]);
  const { messages, setMessages, sendMessage, stop, clearError, status, error: chatError } = useChat<UIMessage>({
    id, transport,
    onFinish: () => { void refresh(); },
    onError: e => { if (mounted.current) setError(e.message); },
  });
  const generating = status === 'submitted' || status === 'streaming' || task?.status === 'generating' || task?.status === 'building';
  const canEdit = !!user && user.id === app?.userId;

  useEffect(() => {
    mounted.current = true;
    let live = true;
    void api<AppInfo>('app/get/vo?id=' + encodeURIComponent(id)).then(info => {
      if (live) setApp(info);
    }).catch(e => { if (live) setError(e.message); });
    void Promise.all([
      api<UIMessage[]>('app/messages?appId=' + encodeURIComponent(id)),
      api<Generation | null>('app/generation?appId=' + encodeURIComponent(id)),
    ]).then(([history, generation]) => {
      if (!live) return;
      setMessages(history);
      setTask(generation);
      setLoaded(true);
      if (!history.length) {
        void api<AppInfo>('app/get/vo?id=' + encodeURIComponent(id)).then(info => {
          if (live) setInput(current => current || info.initPrompt);
        }).catch(e => { if (live) setError(e.message); });
      }
    }).catch(e => { if (live) setHistoryError(e.message); });
    return () => { live = false; mounted.current = false; void stop(); };
  }, [id, setMessages, stop]);

  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(() => { void refresh(); }, 750);
    return () => clearInterval(timer);
  }, [generating, refresh]);
  useEffect(() => {
    const list = messageList.current;
    if (!list) return;
    if (loadingOlder.current) { loadingOlder.current = false; return; }
    list.scrollTop = list.scrollHeight;
  }, [messages, visibleHistory]);

  const previewOrigin = app?.previewUrl ? new URL(app.previewUrl).origin : null;
  const editorMessage = useCallback((value: Record<string, unknown>) => {
    if (previewOrigin) iframe.current?.contentWindow?.postMessage(value, previewOrigin);
  }, [previewOrigin]);
  useEffect(() => {
    editorMessage({ type: 'TOGGLE_EDIT_MODE', editMode: editing });
    if (!editing) setSelected(null);
  }, [editing, editorMessage]);
  useEffect(() => {
    function receive(event: MessageEvent) {
      if (!previewOrigin || event.origin !== previewOrigin || event.source !== iframe.current?.contentWindow ||
          !event.data || typeof event.data !== 'object') return;
      if (event.data.type === 'EDITOR_READY') editorMessage({ type: 'TOGGLE_EDIT_MODE', editMode: editing });
      const info = event.data.elementInfo;
      if (editing && canEdit && event.data.type === 'ELEMENT_SELECTED' && info &&
          typeof info.selector === 'string' && info.selector.length > 0 && info.selector.length <= 512 &&
          typeof info.tagName === 'string' && info.tagName.length <= 64 && typeof info.textContent === 'string') {
        setSelected({ selector: info.selector, tagName: info.tagName, textContent: info.textContent.slice(0, 2000) });
      }
    }
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [previewOrigin, editing, canEdit, editorMessage]);

  async function submit() {
    if (!input.trim() || generating || submitting.current || !canEdit || !loaded) return;
    submitting.current = true;
    const original = input;
    const text = input.trim() + (selected ? `\n可视化选中元素 ${selected.selector}，原文 ${selected.textContent}` : '');
    setError(''); clearError(); setInput(''); setSelected(null); setEditing(false);
    try {
      await sendMessage({ text });
      await refresh();
    } catch (e) {
      if (mounted.current) { setInput(original); setError((e as Error).message); }
    } finally { submitting.current = false; }
  }
  async function cancel() {
    setCancelling(true);
    try {
      await api('app/generation/cancel', { appId: id });
      await stop(); await refresh();
    } catch (e) { message.error((e as Error).message); }
    finally { if (mounted.current) setCancelling(false); }
  }
  async function deploy() {
    setPublishing(true);
    try {
      await api<string>('app/deploy', { appId: id });
      message.success('应用发布成功'); await refresh();
    } catch (e) { message.error((e as Error).message); }
    finally { if (mounted.current) setPublishing(false); }
  }
  const problem = error || chatError?.message || task?.error;
  const visibleMessages = messages.slice(-visibleHistory);
  const actionsDisabled = !canEdit || generating || !app?.previewUrl;
  return <main className="chat-page">
    <div className="chat-toolbar">
      <h1>{app?.appName || '应用对话'}</h1>
      {task && <Tag color={task.status === 'ready' ? 'green' : task.status === 'failed' ? 'red' : 'default'}>{statusLabels[task.status]}</Tag>}
      <Button href={canEdit ? '/app/edit/' + id : undefined} icon={<EditOutlined aria-hidden="true" />} disabled={!canEdit}>编辑应用</Button>
      <Button href={!actionsDisabled ? '/api/app/download/' + encodeURIComponent(id) : undefined} icon={<DownloadOutlined aria-hidden="true" />} disabled={actionsDisabled}>下载代码</Button>
      <Button type="primary" icon={<CloudUploadOutlined aria-hidden="true" />} loading={publishing} disabled={actionsDisabled} onClick={() => { void deploy(); }}>发布应用</Button>
    </div>
    {problem && <Alert style={{ marginBottom: 12 }} type="error" title={problem} />}
    {historyError && <Alert style={{ marginBottom: 12 }} type="warning" title={'对话历史暂不可读取：' + historyError} />}
    <div className="chat-columns">
      <section className="chat-panel" aria-label="应用对话">
        <div className="messages" ref={messageList}>
          {messages.length > visibleHistory && <Button type="link" onClick={() => { loadingOlder.current = true; setVisibleHistory(count => count + historyPageSize); }}>加载更多历史消息</Button>}
          {!messages.length && <div className="message-row"><div className="message-role">初始需求</div><div className="message-text">{app?.initPrompt || '加载应用…'}</div></div>}
          {visibleMessages.map(item => <div className={'message-row ' + (item.role === 'user' ? 'message-user' : '')} key={item.id}>
            <div className="message-role">{item.role === 'user' ? '你' : 'AI 助手'}</div>
            {item.parts.map((part, index) => part.type === 'text' ? <div className="message-text" key={index}>{part.text}</div> :
              part.type === 'reasoning' ? <details key={index}><summary>思考过程</summary><div className="message-text">{part.text}</div></details> :
              part.type.startsWith('tool-') ? <details className="tool-result" key={index}><summary>{part.type.replace('tool-', '')} 工具状态</summary><pre>{JSON.stringify(part, null, 2)}</pre></details> : null)}
          </div>)}
          {generating && <p role="status">正在生成或构建，请稍候…</p>}
        </div>
        <div className="chat-input">
          {selected && <Alert type="info" title={'已选中 ' + selected.selector} closable onClose={() => setSelected(null)} style={{ marginBottom: 8 }} />}
          <Input.TextArea aria-label="对话消息" placeholder={canEdit ? '描述你想生成或修改的内容' : '只有创建者可以生成代码'} value={input}
            onChange={e => setInput(e.target.value)} disabled={!canEdit || !loaded} autoSize={{ minRows: 3, maxRows: 6 }} maxLength={16000}
            onKeyDown={e => { if (!e.nativeEvent.isComposing && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } }} />
          <div className="prompt-actions"><span style={{ fontSize: 12, color: '#928278' }}>Ctrl + Enter 发送</span>
            {generating ? <Button danger icon={<StopOutlined aria-hidden="true" />} loading={cancelling} onClick={() => { void cancel(); }}>停止生成</Button> :
              <Button type="primary" icon={<SendOutlined aria-hidden="true" />} disabled={!canEdit || !loaded || !input.trim()} onClick={() => { void submit(); }}>发送</Button>}
          </div>
        </div>
      </section>
      <section className="preview-panel">
        <div className="preview-bar"><span>实时预览</span><Space>
          <Button size="small" disabled={actionsDisabled} type={editing ? 'primary' : 'default'} onClick={() => setEditing(value => !value)}>可视化编辑</Button>
          {app?.deployUrl && <a href={app.deployUrl} target="_blank" rel="noopener noreferrer">访问作品</a>}
        </Space></div>
        {app?.previewUrl ? <iframe ref={iframe} className="preview-frame" title="应用预览"
          src={app.previewUrl + (app.previewUrl.includes('?') ? '&' : '?') + 'generation=' + encodeURIComponent(task?.id || '')}
          sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" onLoad={() => editorMessage({ type: 'TOGGLE_EDIT_MODE', editMode: editing })} /> :
          <div className="preview-empty">发送需求后，生成的应用会显示在这里。</div>}
      </section>
    </div>
  </main>;
}
