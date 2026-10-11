'use client';
import { use, useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { App, Button, Input, Alert, Tag, Space, Spin, Avatar } from 'antd';
import { SendOutlined, DownloadOutlined, CloudUploadOutlined, EditOutlined, StopOutlined, InfoCircleOutlined, ExportOutlined, UserOutlined } from '@ant-design/icons';
import { api } from '@/client/api';
import { useAuth } from '@/components/providers';
import type { AppInfo, Generation } from '@/shared/contracts';
import { MarkdownMessage } from '@/components/chat/markdown-message';
import { AppDetailModal, formatCodeGenType } from '@/components/chat/app-detail-modal';
import { DeploySuccessModal } from '@/components/chat/deploy-success-modal';
import './chat.css';

type Selected = { selector: string; tagName: string; id: string; className: string; textContent: string; pagePath: string };
const statusLabels = { generating: '生成中', building: '构建中', ready: '可预览', failed: '失败', cancelled: '已取消' } as const;
const historyPageSize = 10;
const inputLimit = 1000;

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
  const [visibleHistory, setVisibleHistory] = useState(historyPageSize);
  const [detailOpen, setDetailOpen] = useState(false);
  const [deployModal, setDeployModal] = useState<{ open: boolean; url: string }>({ open: false, url: '' });
  const iframe = useRef<HTMLIFrameElement>(null);
  const messageList = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const submitting = useRef(false);
  const initialPromptHandled = useRef(false);
  const loadingOlder = useRef(false);
  const canEdit = !!user && user.id === app?.userId;
  const isAdmin = user?.userRole === 'admin';
  const loaded = appLoaded && historySettled;

  const refresh = useCallback(async () => {
    const [info, generation] = await Promise.allSettled([
      api<AppInfo>('app/get/vo?id=' + encodeURIComponent(id)),
      api<Generation | null>('app/generation?appId=' + encodeURIComponent(id)),
    ]);
    if (!mounted.current) return;
    if (info.status === 'fulfilled') setApp(info.value);
    if (generation.status === 'fulfilled') setTask(generation.value);
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
          api<UIMessage[]>('app/messages?appId=' + encodeURIComponent(id)),
          api<Generation | null>('app/generation?appId=' + encodeURIComponent(id)),
        ]);
        if (!live) return;
        setMessages(history);
        setTask(generation);
        setHistoryLoaded(true);
        if (!history.length) setInput(current => current || info.initPrompt);
      } catch (e) {
        if (!live) return;
        setHistoryError((e as Error).message);
        setInput(current => current || info.initPrompt);
      } finally {
        // Sending stays blocked until the private history request settles, so a
        // manual submit cannot race the automatic first prompt.
        if (live) setHistorySettled(true);
      }
    })();
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
    if (!editing) { setSelected(null); editorMessage({ type: 'CLEAR_ALL_EFFECTS' }); }
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

  const submit = useCallback(async (original: string = input) => {
    if (!original.trim() || generating || submitting.current || !canEdit || !loaded) return;
    const context = selected ? selectionContext(selected) : '';
    const text = original.trim() + context;
    if (text.length > inputLimit) { setError('消息与选中元素信息合计不能超过 1000 字，请精简后重试'); return; }
    initialPromptHandled.current = true;
    submitting.current = true;
    setError(''); clearError(); setDismissedTaskError(''); setInput(''); setSelected(null); setEditing(false);
    try {
      await sendMessage({ text });
      await refresh();
    } catch (e) {
      if (mounted.current) { setInput(original); setError((e as Error).message); }
    } finally { submitting.current = false; }
  }, [input, generating, canEdit, loaded, selected, clearError, sendMessage, refresh]);

  useEffect(() => {
    if (!appLoaded || !historyLoaded || authLoading || !app || initialPromptHandled.current) return;
    initialPromptHandled.current = true;
    if (canEdit && !messages.length && !task && !generating && app.initPrompt.trim()) void submit(app.initPrompt);
  }, [appLoaded, historyLoaded, authLoading, app, canEdit, messages.length, task, generating, submit]);

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
  const problem = error || chatError?.message || (taskErrorKey !== dismissedTaskError ? task?.error : null);
  const visibleMessages = messages.slice(-visibleHistory);
  const sourceAvailable = app?.sourceAvailable ?? !!app?.previewUrl;
  const canPreview = !!app?.previewUrl;
  const canDownload = canEdit && sourceAvailable && !generating;
  const canDeploy = canEdit && (canPreview || sourceAvailable) && !generating;
  const contextLength = selected ? selectionContext(selected).length : 0;
  const textareaMax = Math.max(0, inputLimit - contextLength);
  const previewSrc = canPreview && app?.previewUrl
    ? app.previewUrl + (app.previewUrl.includes('?') ? '&' : '?') + 'generation=' + encodeURIComponent(task?.id || '')
    : undefined;

  return <main className="chat-page">
    <div className="chat-toolbar">
      <h1 className="chat-app-name">{app?.appName || '网站生成器'}</h1>
      {app?.codeGenType && <Tag color="blue">{formatCodeGenType(app.codeGenType)}</Tag>}
      {task && <Tag color={task.status === 'ready' ? 'green' : task.status === 'failed' ? 'red' : 'default'}>{statusLabels[task.status]}</Tag>}
      <Space wrap>
        <Button icon={<InfoCircleOutlined aria-hidden="true" />} disabled={!app} onClick={() => setDetailOpen(true)}>应用详情</Button>
        <Button href={canEdit ? '/app/edit/' + id : undefined} icon={<EditOutlined aria-hidden="true" />} disabled={!canEdit}>编辑应用</Button>
        <Button href={canDownload ? '/api/app/download/' + encodeURIComponent(id) : undefined} icon={<DownloadOutlined aria-hidden="true" />} disabled={!canDownload}>下载代码</Button>
        <Button type="primary" icon={<CloudUploadOutlined aria-hidden="true" />} loading={publishing} disabled={!canDeploy} onClick={() => { void deploy(); }}>部署</Button>
      </Space>
    </div>
    {problem && <Alert style={{ marginBottom: 12 }} type="error" title={problem} closable={{ 'aria-label': '关闭错误提示' }} onClose={() => { setError(''); clearError(); setDismissedTaskError(taskErrorKey); }} />}
    {historyError && <Alert style={{ marginBottom: 12 }} type="warning" title={'对话历史暂不可读取：' + historyError} />}
    <div className="chat-columns">
      <section className="chat-panel" aria-label="应用对话">
        <div className="messages" ref={messageList}>
          {messages.length > visibleHistory && <Button type="link" onClick={() => { loadingOlder.current = true; setVisibleHistory(count => count + historyPageSize); }}>加载更多历史消息</Button>}
          {!messages.length && <div className="message-item initial-prompt"><div className="message-role">初始需求</div><div className="message-text">{app?.initPrompt || '加载应用…'}</div></div>}
          {visibleMessages.map(item => item.role === 'user'
            ? <div className="message-item message-user" key={item.id}>
                <div className="message-bubble">{item.parts.map((part, index) => part.type === 'text' ? <div className="message-text" key={index}>{part.text}</div> : null)}</div>
                <Avatar className="message-avatar" src={user?.userAvatar ?? undefined} icon={<UserOutlined />} />
              </div>
            : <div className="message-item message-ai" key={item.id}>
                <Avatar className="message-avatar" src="/paimeng.png" alt="AI 助手" />
                <div className="message-bubble">{item.parts.map((part, index) =>
                  part.type === 'text' ? <MarkdownMessage key={index} content={part.text} /> :
                  part.type === 'reasoning' ? <details className="reasoning" key={index}><summary>思考过程</summary><div className="message-text">{part.text}</div></details> :
                  part.type.startsWith('tool-') ? <details className="tool-result" key={index}><summary>{part.type.replace('tool-', '')} 工具状态</summary><pre>{JSON.stringify(part, null, 2)}</pre></details> : null)}
                </div>
              </div>
          )}
        </div>
        {generating && <p className="generating-hint" role="status">正在生成或构建，请稍候…</p>}
        <div className="chat-input">
          {selected && <Alert className="selected-element-alert" type="info" closable onClose={() => setSelected(null)}
            title={'已选中 ' + selected.tagName.toLowerCase() + (selected.id ? ' #' + selected.id : '') + (selected.className ? ' .' + selected.className.split(/\s+/).filter(Boolean).join('.') : '')}
            description={<div className="element-details">
              {selected.pagePath && <div className="element-item">页面路径: {selected.pagePath}</div>}
              <div className="element-item">选择器: <code className="element-selector-code">{selected.selector}</code></div>
              {selected.textContent && <div className="element-item">内容: {selected.textContent.slice(0, 50)}{selected.textContent.length > 50 ? '…' : ''}</div>}
            </div>} />}
          <Input.TextArea aria-label="对话消息" placeholder={canEdit ? '请描述你想生成的网站，越详细效果越好哦' : '无法在别人的作品下对话哦~'} value={input}
            onChange={e => setInput(e.target.value)} disabled={!canEdit || !loaded} autoSize={{ minRows: 3, maxRows: 6 }} maxLength={textareaMax}
            onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); } }} />
          <div className="prompt-actions"><span className="composer-hint">Enter 发送，Shift + Enter 换行</span>
            {generating ? <Button danger icon={<StopOutlined aria-hidden="true" />} loading={cancelling} onClick={() => { void cancel(); }}>停止生成</Button> :
              <Button type="primary" icon={<SendOutlined aria-hidden="true" />} disabled={!canEdit || !loaded || !input.trim()} onClick={() => { void submit(); }}>发送</Button>}
          </div>
        </div>
      </section>
      <section className="preview-panel">
        <div className="preview-bar"><h3>生成后的网页展示</h3><Space>
          {canPreview && <Button size="small" type="link" danger={editing} disabled={!canEdit || generating} onClick={() => setEditing(value => !value)}>{editing ? '退出编辑' : '可视化编辑'}</Button>}
          {canPreview && <Button size="small" type="link" icon={<ExportOutlined aria-hidden="true" />} onClick={() => { if (app?.previewUrl) window.open(app.previewUrl, '_blank', 'noopener'); }}>新窗口打开</Button>}
          {app?.deployUrl && <a href={app.deployUrl} target="_blank" rel="noopener noreferrer">访问作品</a>}
        </Space></div>
        {generating ? <div className="preview-loading" role="status"><Spin size="large" /><p>正在生成网站...</p></div> :
          canPreview ? <iframe ref={iframe} className="preview-frame" title="应用预览" src={previewSrc} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" onLoad={() => editorMessage({ type: 'TOGGLE_EDIT_MODE', editMode: editing })} /> :
          <div className="preview-placeholder"><div className="preview-placeholder-icon">🌐</div><p>网站文件生成完成后将在这里展示</p></div>}
      </section>
    </div>
    <AppDetailModal open={detailOpen} app={app} showActions={canEdit || !!isAdmin} onClose={() => setDetailOpen(false)}
      onEdit={() => { setDetailOpen(false); router.push('/app/edit/' + id); }} onDelete={() => { void removeApp(); }} />
    <DeploySuccessModal open={deployModal.open} deployUrl={deployModal.url} onClose={() => setDeployModal(current => ({ ...current, open: false }))}
      onOpenSite={() => { if (deployModal.url) window.open(deployModal.url, '_blank', 'noopener'); }} />
  </main>;
}
