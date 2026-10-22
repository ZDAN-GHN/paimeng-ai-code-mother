'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Drawer, Select, Spin, Tag } from 'antd';
import {
  BranchesOutlined, CloseOutlined, DiffOutlined, HistoryOutlined, PictureOutlined, ReloadOutlined, UndoOutlined,
} from '@ant-design/icons';
import { api } from '@/client/api';
import { parseStoredTime } from '@/shared/display';
import { VersionTreeLegend, VersionTreeLines, treeGutterWidth, treeRowHeight } from './version-graph';
import { DEFAULT_BRANCH, type AppVersion, type AppVersionOverview, type VersionDiff } from '@/shared/versioning';
import './version-panel.css';

/**
 * 版本历史面板。
 *
 * 默认只讲一件人话：<这个版本长什么样> + <用这一版> + <从这版接着改>。
 * 「分支 / 合并 / 提交 SHA / 树状路径」是 Git 的说法，收在「修改路径与分支」里按需展开——
 * 非技术用户不需要理解它们，也能完成「找回喜欢的那一版」和「在那版上继续改」。
 * 底层仍然是 Git：切版只把工作区切到那次提交（detached HEAD），不新增版本，也不删历史。
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

/** 提交 SHA 只给排障用：界面上不再展示，需要时放在 title 属性里。 */
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

export function VersionPanel({ appId, open, onClose, onWorkspaceChanged, onStartFromVersion, onAfterClose }: {
  appId: string;
  open: boolean;
  onClose: () => void;
  /** 版本内容已改变工作区（使用旧版/开分支/合并/切换）后调用，让页面刷新预览与消息。 */
  onWorkspaceChanged: () => void;
  /** 「从这版接着改」：面板收起并把光标放回输入框，用户直接说下一句需求。 */
  onStartFromVersion?: () => void;
  /** 抽屉关闭动画结束后触发：antd 会把焦点还给触发按钮，页面得等这一刻才能把焦点交给输入框。 */
  onAfterClose?: () => void;
}) {
  const { message, modal } = App.useApp();
  const [state, setState] = useState<OverviewState>({ status: 'loading' });
  const [diff, setDiff] = useState<DiffState>({ status: 'idle' });
  const [busy, setBusy] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
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
    setAdvanced(false);
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
  const onSideBranch = currentBranch !== null && currentBranch !== DEFAULT_BRANCH;
  const canWrite = overview !== null && overview.blocked === null && busy === null;
  const withTree = advanced && Boolean(overview?.graph);

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

  const confirmBranch = (version: AppVersion) => {
    modal.confirm({
      title: `从「${version.title}」单独开一条修改路径？`,
      content: '平台会从这一版另起一条路径并切过去，主线当前内容不受影响；之后在这条路径上的改动以这一版为起点。',
      okText: '开始新路径',
      cancelText: '取消',
      onOk: () => runWrite(`branch:${version.id}`, async () => {
        const result = await api<BranchResult>('app/versions/branch', { appId, versionId: version.id });
        return { text: `已从「${result.version.title}」开始新的修改路径`, changed: true, previewError: result.previewError };
      }),
    });
  };

  const confirmAdopt = (branch: string) => {
    modal.confirm({
      title: `把「${branch}」这条路径合并回来？`,
      content: '平台会把这条路径上的改动并进主线，已有历史不会丢，这条路径也可以继续保留。',
      okText: '合并回来',
      cancelText: '取消',
      onOk: () => runWrite(`adopt:${branch}`, async () => {
        const result = await api<AdoptResult>('app/versions/adopt', { appId, branch });
        return result.version
          ? { text: `已把「${result.branch}」合并回主线`, changed: true, previewError: result.previewError }
          : { text: `「${result.branch}」已经包含在主线里，没有产生新版本`, changed: false, previewError: result.previewError };
      }),
    });
  };

  const confirmSwitch = (branch: string) => {
    if (branch === currentBranch) return;
    modal.confirm({
      title: `切换到「${branch}」？`,
      content: '页面会换成这条路径上的最新内容，不会新增版本；切回 main 就回到主线。',
      okText: '切换',
      cancelText: '取消',
      onOk: () => runWrite(`switch:${branch}`, async () => {
        const result = await api<SwitchResult>('app/versions/switch', { appId, branch });
        return { text: `已切换到「${result.branch}」`, changed: true, previewError: result.previewError };
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
          {detached
            ? <>
              <Tag color="orange">旧版本</Tag>
              <span className="version-panel-status-text">你正在看一个旧版本，新的修改会从这里开始。</span>
              <Button size="small" disabled={!canWrite} loading={busy === 'switch:main'} onClick={() => confirmSwitch(DEFAULT_BRANCH)}>回到最新</Button>
            </>
            : onSideBranch
              ? <>
                <Tag color="purple">另一条修改路径</Tag>
                <span className="version-panel-status-text">{currentBranch}</span>
                <Button size="small" disabled={!canWrite} loading={busy === `switch:${DEFAULT_BRANCH}`} onClick={() => confirmSwitch(DEFAULT_BRANCH)}>回到主线</Button>
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
          : <div className={withTree ? 'version-tree' : 'version-list'}>
            {withTree && overview?.graph && <VersionTreeLegend graph={overview.graph} />}
            <div className={withTree ? 'version-tree-body' : 'version-list-body'} style={withTree && overview?.graph ? { paddingLeft: treeGutterWidth(overview.graph) } : undefined}>
              {withTree && overview?.graph && <div className="version-tree-gutter"><VersionTreeLines graph={overview.graph} /></div>}
              {treeOrder.map(version => {
                const isCurrent = version.id === currentVersion?.id;
                const node = overview?.graph?.nodes.find(item => item.versionId === version.id);
                return <div
                  className={['version-tree-row', isCurrent && 'version-tree-row-current'].filter(Boolean).join(' ')}
                  key={version.id}
                  style={withTree && overview?.graph ? { height: treeRowHeight(overview.graph) } : undefined}
                  data-lane={node?.lane ?? 0}
                >
                  <VersionThumbnail appId={appId} version={version} />
                  <div className="version-tree-row-body">
                    <div className="version-tree-row-head">
                      <span className="version-tree-row-title">{version.title}</span>
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
                    </div>
                    {advanced && <div className="version-row-advanced">
                      <span className="version-row-sha" title={version.id}>{shortSha(version.id)}</span>
                      <span className="version-row-meta" title={version.statsKnown ? undefined : '这一版的内容读不出来，统计不可用'}>
                        {version.statsKnown ? `${version.fileCount} 个文件` : '统计不可用'}
                      </span>
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
                        icon={<BranchesOutlined aria-hidden="true" />}
                        disabled={!canWrite}
                        loading={busy === `branch:${version.id}`}
                        onClick={() => confirmBranch(version)}
                      >从此版另起一条路径</Button>
                    </div>}
                  </div>
                </div>;
              })}
            </div>
          </div>}
        <div className="version-panel-advanced">
          <Button
            type="link"
            size="small"
            aria-expanded={advanced}
            onClick={() => setAdvanced(value => !value)}
          >{advanced ? '收起修改路径与分支' : '修改路径与分支（高级）'}</Button>
          {advanced && <>
            <p className="version-panel-advanced-note">每一版都是 Git 里的一个提交。这里能看到它们在 Git 里的编号、比较两版差异，也可以把一条修改路径合并回主线。</p>
            <div className="version-panel-branches">
              <span className="version-panel-section-title">当前所在分支</span>
              <Select
                size="small"
                className="version-panel-branch-select"
                value={currentBranch}
                placeholder={detached ? '切换回某个分支' : undefined}
                options={branchOptions}
                disabled={!branchOptions.some(option => option.value !== currentBranch) || !canWrite}
                onChange={confirmSwitch}
              />
            </div>
            {openBranches.length > 0 && <section className="version-panel-branches" aria-label="未合并分支">
              <span className="version-panel-section-title">还没合并回主线的路径</span>
              {openBranches.map(branch => <div className="version-panel-branch-row" key={branch.branch}>
                <BranchesOutlined aria-hidden="true" className="version-panel-branch-icon" />
                <span className="version-panel-branch-name">{branch.branch}</span>
                <Button
                  size="small"
                  disabled={!canWrite}
                  loading={busy === `adopt:${branch.branch}`}
                  onClick={() => confirmAdopt(branch.branch)}
                >合并回主线</Button>
              </div>)}
            </section>}
          </>}
        </div>
      </>}
    </div>
  </Drawer>;
}
