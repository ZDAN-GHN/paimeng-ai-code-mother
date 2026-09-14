import type { InterviewState } from './index.js'

export interface WireframeState {
  relativeUrl: string
  pageCount: number
  confirmed?: boolean
  confirmedAt?: string
}

export interface PlanningArtifact {
  pages: string[]
  siteMap: Array<{ page: string; anchor: string; linksTo: string[] }>
  pageSummaries: Array<{ page: string; blocks: string[] }>
}

export interface RunContext {
  interview?: InterviewState
  wireframe?: WireframeState
  planning?: PlanningArtifact
}

export function buildPlanningArtifact(summary: { pages: string[] }): PlanningArtifact {
  const pages = summary.pages.slice(0, 5)
  return {
    pages,
    siteMap: pages.map((page, index) => ({
      page,
      anchor: `page-${index}`,
      linksTo: pages.filter((_, targetIndex) => targetIndex !== index),
    })),
    pageSummaries: pages.map((page) => ({
      page,
      blocks: [
        '顶部导航栏（logo + 菜单占位）',
        '主视觉 Banner 图片占位',
        '三列内容卡片图片占位',
        '页脚占位',
      ],
    })),
  }
}

export function parseContext(raw: string | null | undefined): RunContext {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as RunContext
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
