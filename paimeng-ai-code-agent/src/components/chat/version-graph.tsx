import { memo } from 'react';
import type { VersionGraph } from '@/shared/versioning';

/** 分支配色：main 固定蓝色，其余按分支首次出现的顺序取色，同一分支永远同一颜色。 */
const branchPalette = ['#3f7fd6', '#cb573e', '#2f9e6f', '#a061c9', '#c08a2e'];

export function createBranchColors(graph: VersionGraph) {
  const names: string[] = [];
  for (const lane of graph.lanes) if (!names.includes(lane.branch)) names.push(lane.branch);
  for (const node of graph.nodes) if (!names.includes(node.branch)) names.push(node.branch);
  const preferred = ['main', ...names.filter(name => name !== 'main')];
  const colors = new Map<string, string>();
  preferred.forEach((name, index) => colors.set(name, branchPalette[index % branchPalette.length]!));
  return colors;
}

/** 图例：一条分支一项；颜色与节点、连线一致。 */
export const VersionTreeLegend = memo(function VersionTreeLegend({ graph }: { graph: VersionGraph }) {
  const colors = createBranchColors(graph);
  const branches = [...new Map(graph.lanes.map(lane => [lane.branch, lane])).values()];
  return <div className="version-tree-legend">
    {branches.map(lane => <span key={lane.branch} className="version-tree-legend-item">
      <i style={{ background: colors.get(lane.branch) }} aria-hidden="true" />
      {lane.branch}
      {lane.status !== 'open' && <span className="version-tree-legend-note">{lane.status === 'adopted' ? '已采纳' : '已废弃'}</span>}
    </span>)}
  </div>;
});

/**
 * 版本历史的树。几何与配色依据都来自服务端：
 * 节点和连线按「这条提交属于哪条分支」着色，而不是按泳道——
 * 同一条泳道会先后走过两条分支，按泳道上色就会出现「两条分支三种颜色」的错觉。
 */
export const VersionTreeLines = memo(function VersionTreeLines({ graph }: { graph: VersionGraph }) {
  const { geometry } = graph;
  const colors = createBranchColors(graph);
  const color = (branch: string) => colors.get(branch) ?? branchPalette[0]!;
  const xOf = (lane: number) => geometry.gutterPadding + lane * geometry.laneGap + geometry.laneGap / 2;
  const yOf = (row: number) => row * geometry.rowHeight + geometry.rowHeight / 2;

  return <svg
    className="version-tree-lines"
    width={geometry.width}
    height={geometry.height}
    viewBox={`0 0 ${geometry.width} ${geometry.height}`}
    aria-hidden="true"
    focusable="false"
  >
    {geometry.edges.map(edge => <line
      key={`e${edge.lane}-${edge.rowFrom}-${edge.rowTo}`}
      x1={xOf(edge.lane)} x2={xOf(edge.lane)}
      y1={yOf(edge.rowFrom)} y2={yOf(edge.rowTo)}
      stroke={color(edge.branch)}
      strokeWidth={2.5}
      strokeLinecap="round"
      opacity={0.85}
    />)}
    {geometry.curves.map(curve => {
      const x1 = xOf(curve.laneFrom);
      const x2 = xOf(curve.laneTo);
      const y1 = yOf(curve.rowFrom);
      const y2 = yOf(curve.rowTo);
      const bend = (y2 - y1) * 0.55;
      return <path
        key={`c${curve.laneFrom}-${curve.rowFrom}-${curve.laneTo}`}
        d={`M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`}
        stroke={color(curve.branch)}
        strokeWidth={2.5}
        strokeLinecap="round"
        fill="none"
        opacity={0.85}
      />;
    })}
    {geometry.nodes.map(node => <g key={`n${node.lane}-${node.row}`}>
      {/* 白底外环让节点压在连线上也看得清 */}
      <circle cx={node.x} cy={node.y} r={node.state === 'head' ? 7 : 6} fill="#fff" />
      <circle
        cx={node.x} cy={node.y}
        r={node.state === 'head' ? 5.5 : 4.5}
        fill={node.state === 'normal' ? '#fff' : color(node.branch)}
        stroke={color(node.branch)}
        strokeWidth={2.5}
        opacity={node.state === 'stale' ? 0.5 : 1}
      />
    </g>)}
  </svg>;
});

export const treeGutterWidth = (graph: VersionGraph) => graph.geometry.width;
export const treeRowHeight = (graph: VersionGraph) => graph.geometry.rowHeight;
export const treeBranchColor = (graph: VersionGraph, branch: string) => createBranchColors(graph).get(branch) ?? branchPalette[0]!;
