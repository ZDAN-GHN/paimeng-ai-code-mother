'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Drawer, Spin, Tag } from 'antd';
import { CloseOutlined, DiffOutlined, HistoryOutlined, PictureOutlined, ReloadOutlined, UndoOutlined } from '@ant-design/icons';
import { api } from '@/client/api';
import { parseStoredTime } from '@/shared/display';
import type { AppVersion, AppVersionOverview, VersionDiff } from '@/shared/versioning';
import './version-panel.css';

/**
 * 版本历史面板。
 *
 * 一条按时间排的清单，每行讲三件事：这一版长什么样、标题说了什么改动、能不能用。
 * 每行两个动作：「使用这个版本」把页面换回去，「根据这版修改」从这一版接着改。
 * 没有分支、合并、泳道——这里不是 Git 客户端，只是用户找回喜欢那一版的入口。
 */

type OverviewState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; overview: AppVersionOverview };

type DiffState =
  | { status: 'idle' }
  | { status: 'loading'; base: AppVersion; target: AppVersion }
  | { status: 'failed'; base: AppVersion; target: AppVersion; message: string }
  | { status: 'ready'; diff: VersionDiff };

/** previewError 来自服务端：切版成功后预览重建失败时，不能只报成功，得让用户知道画面为什么没变。 */
type WriteOutcome = { text: string; changed: boolean; previewError?: string | null };
type RestoreResult = { previewError: string | null; status: 'restored' | 'unchanged'; version: AppVersion };

type VersionFileStatus = VersionDiff['files'][number]['status'];

const fileStatusLabels: Record<VersionFileStatus, string> = {
  added: '新增', modified: '修改', deleted: '删除', renamed: '重命名',
};
const fileStatusColors: Record<VersionFileStatus, string> = {
  added: 'green', modified: 'blue', deleted: 'red', renamed: 'purple',
};

const pad = (value: number) => String(value).padStart(2, '0');

/** 提交 SHA 只给排障用：界面上不展示，需要时放在提示里。 */
const shortSha = (sha: string) => sha.slice(0, 7);

/** 今天的版本只显示时分，更早的显示月日——清单里留最多的宽度给标题。 */
function formatVersionTime(value: string, now: Date): string {
  const date = parseStoredTime(value);
  if (!date) return '';
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** 清单按时间倒序；同一时刻的两版保持接口给的顺序。 */
function sortedVersions(list: AppVersion[]): AppVersion[] {
  const timeOf = (version: AppVersion) => parseStoredTime(version.createTime)?.getTime() ?? 0;
  return [...list].sort((left, right) => timeOf(right) - timeOf(left));
}

/** 缩略图按 commit SHA 缓存，可能还没截出来：先占位，加载成功才显示，避免破图。 */
function VersionThumbnail({ appId, version }: { appId: string; version: AppVersion }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const src = '/api/app/versions/thumbnail?appId=' + encodeURIComponent(appId) + '&versionId=' + encodeURIComponent(version.id);
  return <div className={`version-panel-thumb version-panel-thumb-${status}`}>
    {status !== 'ready' && <span className="version-panel-thumb-fallback">
      <PictureOutlined aria-hidden="true" />
      {status === 'failed' && <span className="version-panel-thumb-note">无缩略图</span>}
    </span>}
    {status !== 'failed' && <img
      className="version-panel-thumb-image"
      alt={`「${version.title}」的界面缩略图`}
      src={src}
      onLoad={() => setStatus('ready')}
      onError={() => setStatus('failed')}
    />}
  </div>;
}

function VersionDiffView({ state, onClose }: { state: DiffState; onClose: () => void }) {
  const sectionRef = useRef<HTMLElement>(null);
  const loading = state.status === 'loading';
  useEffect(() => {
    // 对比区在清单上方：从长列表底部点对比时要把它带进视口，否则看起来像没反应。
    if (loading) sectionRef.current?.scrollIntoView({ block: 'nearest' });
  }, [loading]);
  if (state.status === 'idle') return null;
  const base = state.status === 'ready' ? state.diff.base : state.base;
  const target = state.status === 'ready' ? state.diff.target : state.target;
  return <section ref={sectionRef} className="version-panel-diff" aria-label="版本对比">
    <div className="version-panel-diff-head">
      <span className="version-panel-diff-title" title={`${shortSha(base.id)} → ${shortSha(target.id)}`}>
        对比「{base.title}」→「{target.title}」
      </span>
      <Button type="text" size="small" icon={<CloseOutlined aria-hidden="true" />} aria-label="关闭对比" onClick={onClose} />
    </div>
    {state.status === 'loading' && <div className="version-panel-diff-loading"><Spin size="small" />正在读取差异…</div>}
    {state.status === 'failed' && <Alert type="error" title={'读取差异失败：' + state.message} />}
    {state.status === 'ready' && <>
      {state.diff.files.length > 0
        ? <ul className="version-panel-diff-files">{state.diff.files.map(file => <li className="version-panel-diff-file" key={file.status + file.path}>
          <Tag color={fileStatusColors[file.status]}>{fileStatusLabels[file.status]}</Tag>
          <span className="version-panel-diff-path">{file.path}</span>
          <span className="version-panel-diff-count">
            <span className="version-panel-diff-added">+{file.added}</span>
            <span className="version-panel-diff-removed">-{file.removed}</span>
          </span>
        </li>)}</ul>
        : <p className="version-panel-diff-empty">两版内容没有文件差异。</p>}
      <pre className="version-panel-diff-patch">{state.diff.patch || '没有文本补丁。'}</pre>
      {state.diff.truncated && <p className="version-panel-diff-truncated">补丁过长已截断，只显示前面一部分。</p>}
    </>}
  </section>;
}

export type VersionPanelProps = {
  appId: string;
  open: boolean;
  onClose: () => void;
  onAfterClose?: () => void;
  /** 切版成功且工作区真的变了：聊天页据此提示「先重新读文件」。 */
  onWorkspaceChanged: () => void;
  /** 「根据这版修改」：面板关掉、焦点回到输入框。 */
  onStartFromVersion?: () => void;
};

export function VersionPanel({ appId, open, onClose, onAfterClose, onWorkspaceChanged, onStartFromVersion }: VersionPanelProps) {
  const { message, modal } = App.useApp();
  const [state, setState] = useState<OverviewState>({ status: 'loading' });
  const [diff, setDiff] = useState<DiffState>({ status: 'idle' });
  const [busy, setBusy] = useState<string | null>(null);
  const overviewRequest = useRef(0);
  const diffRequest = useRef(0);

  const loadOverview = useCallback(async () => {
    const request = ++overviewRequest.current;
    try {
      const overview = await api<AppVersionOverview>('app/versions?appId=' + encodeURIComponent(appId));
      if (request !== overviewRequest.current) return;
      setState({ status: 'ready', overview });
      setDiff({ status: 'idle' });
    } catch (error) {
      if (request !== overviewRequest.current) return;
      setState({ status: 'failed', message: messageOf(error) });
    }
  }, [appId]);

  useEffect(() => {
    if (!open) return;
    setState({ status: 'loading' });
    setDiff({ status: 'idle' });
    void loadOverview();
  }, [open, loadOverview]);

  const runWrite = useCallback(async (key: string, action: () => Promise<WriteOutcome>) => {
    setBusy(key);
    try {
      const outcome = await action();
      message.success(outcome.text);
      // 源码回去了但预览重建失败：用户看到画面没变会以为没生效，必须当场说明。
      if (outcome.previewError) message.warning(`预览没能重建：${outcome.previewError}`);
      if (outcome.changed) onWorkspaceChanged();
      await loadOverview();
    } catch (error) {
      message.error(messageOf(error));
    } finally {
      setBusy(null);
    }
  }, [loadOverview, message, onWorkspaceChanged]);

  const overview = state.status === 'ready' ? state.overview : null;
  const versions = useMemo(() => overview ? sortedVersions(overview.versions) : [], [overview]);
  const currentVersionId = overview?.current?.versionId ?? null;
  const currentVersion = currentVersionId ? versions.find(version => version.id === currentVersionId) ?? null : null;
  const latest = versions[0] ?? null;
  const onHistory = currentVersionId !== null && latest !== null && currentVersionId !== latest.id;
  const canWrite = overview !== null && overview.blocked === null && busy === null;

  const closeDiff = () => {
    diffRequest.current += 1;
    setDiff({ status: 'idle' });
  };

  const loadDiff = async (version: AppVersion, base: AppVersion) => {
    const request = ++diffRequest.current;
    setDiff({ status: 'loading', base, target: version });
    try {
      const url = 'app/versions/diff?appId=' + encodeURIComponent(appId)
        + '&base=' + encodeURIComponent(base.id) + '&target=' + encodeURIComponent(version.id);
      const result = await api<VersionDiff>(url);
      if (request !== diffRequest.current) return;
      setDiff({ status: 'ready', diff: result });
    } catch (error) {
      if (request !== diffRequest.current) return;
      setDiff({ status: 'failed', base, target: version, message: messageOf(error) });
    }
  };

  const restoreTo = async (version: AppVersion) => {
    const result = await api<RestoreResult>('app/versions/restore', { appId, versionId: version.id });
    return {
      text: result.status === 'unchanged'
        ? `「${result.version.title}」就是现在这一版`
        : `已换成「${result.version.title}」这一版`,
      changed: result.status !== 'unchanged',
      previewError: result.previewError,
    };
  };

  const confirmUse = (version: AppVersion) => {
    modal.confirm({
      title: `换成「${version.title}」这一版？`,
      content: '页面会换成这一版的样子。其他版本都还留着，之后随时能再切回来，也不会新增版本。',
      okText: '使用这一版',
      cancelText: '取消',
      onOk: () => runWrite(`restore:${version.id}`, () => restoreTo(version)),
    });
  };

  const confirmContinue = (version: AppVersion) => {
    if (version.id === currentVersion?.id) {
      onStartFromVersion?.();
      return;
    }
    modal.confirm({
      title: `从「${version.title}」接着改？`,
      content: '页面会先换成这一版，接下来你说的话都从它开始改。现在最新的内容不会丢，之后还能切回来。',
      okText: '从这版接着改',
      cancelText: '取消',
      onOk: () => runWrite(`continue:${version.id}`, async () => {
        const outcome = await restoreTo(version);
        onStartFromVersion?.();
        return { ...outcome, text: `已回到「${version.title}」，接着说要改成什么样` };
      }),
    });
  };

  const now = new Date();

  return <Drawer
    open={open}
    onClose={onClose}
    placement="right"
    size={640}
    afterOpenChange={(visible) => { if (!visible) onAfterClose?.(); }}
    title={<span className="version-panel-drawer-title"><HistoryOutlined aria-hidden="true" />版本历史</span>}
  >
    <div className="version-panel">
      {overview?.blocked && <Alert
        className="version-panel-blocked"
        type="warning"
        title={overview.blocked}
        description="现在还不能切换版本，等这次生成或部署结束后再试。"
      />}
      {state.status === 'loading' && <div className="version-panel-loading"><Spin size="small" />正在读取版本记录…</div>}
      {state.status === 'failed' && <div className="version-panel-error">
        <Alert type="error" title={'读取版本记录失败：' + state.message} />
        <Button icon={<ReloadOutlined aria-hidden="true" />} onClick={() => { setState({ status: 'loading' }); void loadOverview(); }}>重试</Button>
      </div>}
      {overview && <>
        <div className="version-panel-status">
          {onHistory
            ? <>
              <Tag color="orange">旧版本</Tag>
              <span className="version-panel-status-text">你正在看一个旧版本，新的修改会从这里开始。</span>
              <Button
                size="small"
                disabled={!canWrite || latest === null}
                loading={busy === `restore:${latest?.id}`}
                onClick={() => latest && confirmUse(latest)}
              >回到最新</Button>
            </>
            : <span className="version-panel-status-text">当前使用的是最新版本</span>}
        </div>
        <VersionDiffView state={diff} onClose={closeDiff} />
        {versions.length === 0
          ? <div className="version-panel-empty">
            <HistoryOutlined aria-hidden="true" className="version-panel-empty-icon" />
            <p className="version-panel-empty-title">还没有版本记录。完成一次生成后，这里会出现第一个版本。</p>
            <p className="version-panel-empty-note">使用旧版本只会把页面换回去，不会删掉任何一版。</p>
          </div>
          : <div className="version-tree">
            <div className="version-tree-body">
              {versions.map((version, index) => {
                const isCurrent = version.id === currentVersion?.id;
                // 清单按时间倒序，下一行就是上一版：对比动作只跟它比，用户不用自己挑两版。
                const previous = versions[index + 1] ?? null;
                return <div
                  className={['version-tree-row', isCurrent && 'version-tree-row-current'].filter(Boolean).join(' ')}
                  key={version.id}
                >
                  <VersionThumbnail appId={appId} version={version} />
                  <div className="version-tree-row-body">
                    <div className="version-tree-row-head">
                      <span className="version-tree-row-title" title={version.title}>{version.title}</span>
                      {isCurrent && <Tag color="green">正在使用</Tag>}
                      <span className="version-tree-row-time">{formatVersionTime(version.createTime, now)}</span>
                    </div>
                    <div className="version-row-actions">
                      <Button
                        size="small"
                        type={isCurrent ? 'text' : 'primary'}
                        icon={<UndoOutlined aria-hidden="true" />}
                        disabled={!canWrite || isCurrent}
                        title={isCurrent ? '这已经是正在使用的版本' : undefined}
                        loading={busy === `restore:${version.id}`}
                        onClick={() => confirmUse(version)}
                      >使用这个版本</Button>
                      <Button
                        size="small"
                        type="text"
                        disabled={!canWrite}
                        loading={busy === `continue:${version.id}`}
                        onClick={() => confirmContinue(version)}
                      >根据这版修改</Button>
                      <Button
                        size="small"
                        type="text"
                        icon={<DiffOutlined aria-hidden="true" />}
                        disabled={!previous}
                        title={previous ? `和上一版「${previous.title}」比较` : '这是最早的一版，没有可比的上一版'}
                        onClick={() => previous && void loadDiff(version, previous)}
                      >和上一版比</Button>
                    </div>
                  </div>
                </div>;
              })}
            </div>
          </div>}
      </>}
    </div>
  </Drawer>;
}
