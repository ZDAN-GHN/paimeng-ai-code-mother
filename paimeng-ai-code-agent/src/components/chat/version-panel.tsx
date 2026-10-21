'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Drawer, Select, Spin, Tag } from 'antd';
import {
  BranchesOutlined, CloseOutlined, DiffOutlined, HistoryOutlined, PictureOutlined, ReloadOutlined, UndoOutlined,
} from '@ant-design/icons';
import { api } from '@/client/api';
import { parseStoredTime } from '@/shared/display';
import { VersionTreeLegend, VersionTreeLines, treeGutterWidth, treeRowHeight } from './version-graph';
import {
  DEFAULT_BRANCH, type AppVersion, type AppVersionOverview, type VersionDiff,
} from '@/shared/versioning';
import './version-panel.css';

/**
 * 应用版本面板：只读的 Git 历史 + 四个可逆写操作（回到此版本 / 开分支 / 合并到主线 / 切换分支）。
 * 回退只把工作区切到那次提交（detached HEAD），不新增版本，也不删除历史。
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

/** 写操作成功后要不要通知页面刷新：内容没变（例如本来就等于目标版本）就不该触发预览重建。 */
/** previewError 来自服务端：回退成功后预览重建失败时，不能只报成功，得让用户知道画面为什么没变。 */
type WriteOutcome = { text: string; changed: boolean; previewError?: string | null };

type WriteResult = { previewError: string | null };
type RestoreResult = WriteResult & { status: 'restored' | 'unchanged'; version: AppVersion };
type BranchResult = WriteResult & { branch: string; version: AppVersion };
type AdoptResult = WriteResult & { branch: string; version: AppVersion | null };
type SwitchResult = WriteResult & { branch: string; version: AppVersion | null };

type VersionFileStatus = VersionDiff['files'][number]['status'];

const fileStatusLabels: Record<VersionFileStatus, string> = {
  added: '新增', modified: '修改', deleted: '删除', renamed: '重命名',
};
const fileStatusColors: Record<VersionFileStatus, string> = {
  added: 'green', modified: 'blue', deleted: 'red', renamed: 'purple',
};

const pad = (value: number) => String(value).padStart(2, '0');

/** 版本身份是完整 commit SHA：列表与确认框里都只显示前 7 位，完整值放 title 属性。 */
const shortSha = (sha: string) => sha.slice(0, 7);

/** 今天的版本只显示时分，更早的显示月日——时间线上留最多的宽度给标题。 */
function formatVersionTime(value: string, now: Date): string {
  const date = parseStoredTime(value);
  if (!date) return '';
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.toDateString() === now.toDateString() ? time : `${date.getMonth() + 1}月${date.getDate()}日`;
}

const messageOf = (error: unknown) => error instanceof Error && error.message ? error.message : '请求失败';

/** 时间线倒序；同一时刻的提交保持接口给的顺序（Git 已按拓扑排好）。 */
function sortedVersions(versions: AppVersion[]): AppVersion[] {
  const timeOf = (version: AppVersion) => parseStoredTime(version.createTime)?.getTime() ?? 0;
  return [...versions].sort((left, right) => timeOf(right) - timeOf(left));
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
    // 对比区在时间线上方：从长列表底部点「对比」时要把它带进视口，否则看起来像没反应。
    if (loading) sectionRef.current?.scrollIntoView({ block: 'nearest' });
  }, [loading]);
  if (state.status === 'idle') return null;
  const base = state.status === 'ready' ? state.diff.base : state.base;
  const target = state.status === 'ready' ? state.diff.target : state.target;
  return <section ref={sectionRef} className="version-panel-diff" aria-label="版本对比">
    <div className="version-panel-diff-head">
      <span className="version-panel-diff-title">对比 {shortSha(base.id)} → {shortSha(target.id)}</span>
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

export function VersionPanel({ appId, open, onClose, onWorkspaceChanged }: {
  appId: string;
  open: boolean;
  onClose: () => void;
  /** 版本内容已改变工作区（回退/开分支/合并/切换）后调用，让页面刷新预览与消息。 */
  onWorkspaceChanged: () => void;
}) {
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
      // 源码回去了但预览重建失败：用户看到画面没变会以为回退没生效，必须当场说明。
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
  const treeOrder = useMemo(() => {
    if (!overview?.graph) return versions;
    const byId = new Map(versions.map(version => [version.id, version]));
    return overview.graph.nodes.map(node => byId.get(node.versionId)).filter((version): version is NonNullable<typeof version> => Boolean(version));
  }, [overview, versions]);
  const position = overview?.current ?? null;
  const currentVersion = position?.versionId
    ? overview?.versions.find(version => version.id === position.versionId) ?? null
    : null;
  const currentBranch = position?.kind === 'branch' ? position.branch : null;
  const detached = position?.kind === 'detached';
  const canWrite = overview !== null && overview.blocked === null && busy === null;

  const branchOptions = useMemo(() => (overview?.branches ?? []).map(branch => ({ value: branch.branch, label: branch.branch })), [overview]);
  const openBranches = (overview?.branches ?? []).filter(branch => branch.branch !== DEFAULT_BRANCH && !branch.merged);

  const closeDiff = () => {
    diffRequest.current += 1;
    setDiff({ status: 'idle' });
  };

  const loadDiff = async (version: AppVersion, target: AppVersion) => {
    const request = ++diffRequest.current;
    setDiff({ status: 'loading', base: version, target });
    try {
      const url = 'app/versions/diff?appId=' + encodeURIComponent(appId)
        + '&base=' + encodeURIComponent(version.id) + '&target=' + encodeURIComponent(target.id);
      const result = await api<VersionDiff>(url);
      if (request !== diffRequest.current) return;
      setDiff({ status: 'ready', diff: result });
    } catch (error) {
      if (request !== diffRequest.current) return;
      setDiff({ status: 'failed', base: version, target, message: messageOf(error) });
    }
  };

  const confirmRestore = (version: AppVersion) => {
    modal.confirm({
      title: `回到「${version.title}」（${shortSha(version.id)}）？`,
      content: '回到旧版只把工作区切换到这一次 Git 提交，不会新增版本，也不会删除任何历史。之后可以从这里新建分支继续修改，或者切回 main 回到最新内容。',
      okText: '回到此版本',
      cancelText: '取消',
      onOk: () => runWrite(`restore:${version.id}`, async () => {
        const result = await api<RestoreResult>('app/versions/restore', { appId, versionId: version.id });
        return {
          text: result.status === 'unchanged'
            ? `当前已经是「${result.version.title}」（${shortSha(result.version.id)}）`
            : `已回到「${result.version.title}」（${shortSha(result.version.id)}），没有新增版本`,
          changed: result.status !== 'unchanged',
          previewError: result.previewError,
        };
      }),
    });
  };

  const confirmBranch = (version: AppVersion) => {
    modal.confirm({
      title: `从「${version.title}」（${shortSha(version.id)}）开一个新分支？`,
      content: '平台会从这个提交新建分支并切过去，主线当前内容不受影响；之后在新分支上的提交以这一版为父提交。',
      okText: '开分支',
      cancelText: '取消',
      onOk: () => runWrite(`branch:${version.id}`, async () => {
        const result = await api<BranchResult>('app/versions/branch', { appId, versionId: version.id });
        return {
          text: `已从「${result.version.title}」（${shortSha(result.version.id)}）新建分支 ${result.branch} 并切过去`,
          changed: true,
          previewError: result.previewError,
        };
      }),
    });
  };

  const confirmAdopt = (branch: string) => {
    modal.confirm({
      title: `把分支 ${branch} 合并到主线？`,
      content: '平台会把该分支合并进主线，已有历史不会丢，分支本身也可以继续保留。',
      okText: '合并到主线',
      cancelText: '取消',
      onOk: () => runWrite(`adopt:${branch}`, async () => {
        const result = await api<AdoptResult>('app/versions/adopt', { appId, branch });
        return result.version
          ? { text: `已把分支 ${result.branch} 合并到主线`, changed: true, previewError: result.previewError }
          : { text: `分支 ${result.branch} 已经包含在主线里，没有产生新版本`, changed: false, previewError: result.previewError };
      }),
    });
  };

  const confirmSwitch = (branch: string) => {
    if (branch === currentBranch) return;
    modal.confirm({
      title: `切换到分支 ${branch}？`,
      content: '工作区会变成该分支的最新提交，不会新增版本；切回 main 就能回到主线的最新内容。',
      okText: '切换',
      cancelText: '取消',
      onOk: () => runWrite(`switch:${branch}`, async () => {
        const result = await api<SwitchResult>('app/versions/switch', { appId, branch });
        return { text: `已切换到分支 ${result.branch}`, changed: true, previewError: result.previewError };
      }),
    });
  };

  const now = new Date();

  return <Drawer
    open={open}
    onClose={onClose}
    placement="right"
    size={640}
    title={<span className="version-panel-drawer-title"><HistoryOutlined aria-hidden="true" />版本历史</span>}
  >
    <div className="version-panel">
      {overview?.blocked && <Alert
        className="version-panel-blocked"
        type="warning"
        title={overview.blocked}
        description="写操作暂时不可用，等这次生成或部署结束后再试。"
      />}
      {state.status === 'loading' && <div className="version-panel-loading"><Spin size="small" />正在读取版本记录…</div>}
      {state.status === 'failed' && <div className="version-panel-error">
        <Alert type="error" title={'读取版本记录失败：' + state.message} />
        <Button icon={<ReloadOutlined aria-hidden="true" />} onClick={() => { setState({ status: 'loading' }); void loadOverview(); }}>重试</Button>
      </div>}
      {overview && <>
        <div className="version-panel-toolbar">
          {detached
            ? <Tag color="orange">历史版本</Tag>
            : <span className="version-panel-toolbar-label">当前分支</span>}
          <Select
            size="small"
            className="version-panel-branch-select"
            value={currentBranch}
            placeholder={detached ? '切换到分支' : undefined}
            options={branchOptions}
            disabled={!branchOptions.some(option => option.value !== currentBranch) || !canWrite}
            onChange={confirmSwitch}
          />
          {position?.kind === 'detached' && <span className="version-panel-toolbar-sha" title={position.versionId}>{shortSha(position.versionId)}</span>}
          {currentVersion && <span className="version-panel-toolbar-version">当前版本 {shortSha(currentVersion.id)}</span>}
        </div>
        {openBranches.length > 0 && <section className="version-panel-branches" aria-label="未合并分支">
          <span className="version-panel-section-title">未合并分支</span>
          {openBranches.map(branch => <div className="version-panel-branch-row" key={branch.branch}>
            <BranchesOutlined aria-hidden="true" className="version-panel-branch-icon" />
            <span className="version-panel-branch-name">{branch.branch}</span>
            <Button
              size="small"
              disabled={!canWrite}
              loading={busy === `adopt:${branch.branch}`}
              onClick={() => confirmAdopt(branch.branch)}
            >合并到主线</Button>
          </div>)}
        </section>}
        <VersionDiffView state={diff} onClose={closeDiff} />
        {versions.length === 0
          ? <div className="version-panel-empty">
            <HistoryOutlined aria-hidden="true" className="version-panel-empty-icon" />
            <p className="version-panel-empty-title">还没有版本记录。完成一次生成后，这里会出现第一个版本。</p>
            <p className="version-panel-empty-note">回到旧版只会把工作区切换到那次提交，不新增版本，也不删除历史，之后还能再切回来。</p>
          </div>
          : <div className="version-tree">
            {overview?.graph && <VersionTreeLegend graph={overview.graph} />}
            <div className="version-tree-body" style={overview?.graph ? { paddingLeft: treeGutterWidth(overview.graph) } : undefined}>
              {overview?.graph && <div className="version-tree-gutter"><VersionTreeLines graph={overview.graph} /></div>}
              {treeOrder.map(version => {
                const isCurrent = version.id === currentVersion?.id;
                const node = overview?.graph?.nodes.find(item => item.versionId === version.id);
                return <div
                  className={['version-tree-row', isCurrent && 'version-tree-row-current'].filter(Boolean).join(' ')}
                  key={version.id}
                  style={overview?.graph ? { height: treeRowHeight(overview.graph) } : undefined}
                  data-lane={node?.lane ?? 0}
                >
                  <VersionThumbnail appId={appId} version={version} />
                  <div className="version-tree-row-body">
                    <div className="version-tree-row-head">
                      <span className="version-tree-row-sha" title={version.id}>{shortSha(version.id)}</span>
                      {version.heads.map(head => <Tag key={head} color={head === DEFAULT_BRANCH ? 'blue' : undefined}>{head}</Tag>)}
                      {isCurrent && <Tag color="green">当前</Tag>}
                      <span className="version-tree-row-time">{formatVersionTime(version.createTime, now)}</span>
                    </div>
                    <div className="version-tree-row-title">{version.title}</div>
                    <div className="version-tree-row-foot">
                      <span className="version-tree-row-meta">{version.fileCount} 个文件</span>
                      <Button
                        size="small"
                        type="text"
                        icon={<DiffOutlined aria-hidden="true" />}
                        disabled={currentVersion === null || isCurrent}
                        loading={diff.status === 'loading' && diff.base.id === version.id}
                        onClick={() => { if (currentVersion) void loadDiff(version, currentVersion); }}
                      >对比</Button>
                      <Button
                        size="small"
                        type="text"
                        icon={<UndoOutlined aria-hidden="true" />}
                        disabled={!canWrite || isCurrent}
                        title={isCurrent ? '这已经是当前版本' : undefined}
                        loading={busy === `restore:${version.id}`}
                        onClick={() => confirmRestore(version)}
                      >回到此版本</Button>
                      <Button
                        size="small"
                        type="text"
                        icon={<BranchesOutlined aria-hidden="true" />}
                        disabled={!canWrite}
                        loading={busy === `branch:${version.id}`}
                        onClick={() => confirmBranch(version)}
                      >从此版开分支</Button>
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
