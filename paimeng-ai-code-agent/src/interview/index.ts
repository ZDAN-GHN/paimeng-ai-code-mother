import { PAGE_LIMIT } from './wireframe.js'

export const INTERVIEW_DIMENSIONS = ['audience', 'style', 'pages', 'data', 'interaction'] as const
export type InterviewDimension = (typeof INTERVIEW_DIMENSIONS)[number]

export const MAX_INTERVIEW_ROUNDS = 2

export interface InterviewOption {
  id: string
  text: string
  summaryText?: string
  pages?: string[]
}

export interface InterviewQuestion {
  key: InterviewDimension
  dimension: string
  question: string
  options: InterviewOption[]
}

export interface InterviewAnswer {
  key: InterviewDimension
  optionId?: string
  text?: string
}

export interface InterviewState {
  round: number
  message?: string
  answers: Partial<Record<InterviewDimension, { optionId: string; text?: string }>>
  complete: boolean
}

export interface InterviewSummary {
  message: string
  audience: string
  style: string
  pages: string[]
  data: string
  interaction: string
}

export const DIMENSION_LABELS: Record<InterviewDimension, string> = {
  audience: '受众',
  style: '风格',
  pages: '页面清单',
  data: '数据需求',
  interaction: '交互',
}

const QUESTIONS: Record<InterviewDimension, Omit<InterviewQuestion, 'key' | 'dimension'>> = {
  audience: {
    question: '这个应用主要给谁用？',
    options: [
      { id: 'personal', text: '个人 / 个人品牌' },
      { id: 'merchant', text: '小微商家' },
      { id: 'creator', text: '内容创作者' },
      { id: 'local', text: '本地服务机构' },
    ],
  },
  style: {
    question: '希望是什么视觉风格？',
    options: [
      { id: 'modern', text: '简约现代' },
      { id: 'vivid', text: '活泼多彩' },
      { id: 'business', text: '商务稳重' },
      { id: 'artistic', text: '文艺清新' },
    ],
  },
  pages: {
    question: '需要哪些页面？（MVP 上限 5 页）',
    options: [
      { id: 'single', text: '单页（只有首页）', pages: ['首页'] },
      { id: 'home-detail', text: '首页 + 详情页', pages: ['首页', '详情'] },
      { id: 'home-list-detail', text: '首页 + 列表 + 详情', pages: ['首页', '列表', '详情'] },
      {
        id: 'full',
        text: '完整站点（首页+列表+详情+关于+联系）',
        pages: ['首页', '列表', '详情', '关于', '联系'],
      },
    ],
  },
  data: {
    question: '需要展示什么内容 / 数据？',
    options: [
      { id: 'light', text: '少量图文介绍', summaryText: '以少量图文介绍为主' },
      { id: 'gallery', text: '图文 + 作品 / 商品列表' },
      { id: 'form', text: '图文 + 列表 + 预约 / 表单' },
      { id: 'rich', text: '内容较丰富（含详情与多分类）' },
    ],
  },
  interaction: {
    question: '用户需要哪些交互？',
    options: [
      { id: 'view', text: '以浏览为主' },
      { id: 'view-form', text: '浏览 + 表单提交' },
      { id: 'view-form-map', text: '浏览 + 表单 + 地图' },
      { id: 'full', text: '完整交互（搜索 / 登录 / 收藏）' },
    ],
  },
}

function toWireOptions(options: InterviewOption[]): Array<{ id: string; text: string }> {
  return options.map(({ id, text }) => ({ id, text }))
}

function questionOf(key: InterviewDimension): InterviewQuestion {
  return {
    key,
    dimension: DIMENSION_LABELS[key],
    question: QUESTIONS[key].question,
    options: toWireOptions(QUESTIONS[key].options),
  }
}

export function buildRound1Questions(message?: string): InterviewQuestion[] {
  void message
  return INTERVIEW_DIMENSIONS.map(questionOf)
}

export function buildRound2FollowUps(state: InterviewState): InterviewQuestion[] {
  return INTERVIEW_DIMENSIONS.filter((key) => !state.answers[key]?.optionId).map(questionOf)
}

export function mergeAnswers(
  state: InterviewState,
  answers: InterviewAnswer[] | undefined,
): InterviewState {
  const merged: InterviewState = { ...state, answers: { ...state.answers } }
  for (const answer of answers ?? []) {
    if (!answer || !answer.key) continue
    merged.answers[answer.key] = { optionId: answer.optionId ?? '', text: answer.text }
  }
  return merged
}

export function decideNextRound(state: InterviewState): {
  complete: boolean
  questions?: InterviewQuestion[]
} {
  const answeredAll = INTERVIEW_DIMENSIONS.every((key) => Boolean(state.answers[key]?.optionId))
  if (answeredAll || state.round >= MAX_INTERVIEW_ROUNDS) {
    return { complete: true }
  }
  return { complete: false, questions: buildRound2FollowUps(state) }
}

export function buildSummary(state: InterviewState): InterviewSummary {
  const summaryFor = (key: InterviewDimension): string => {
    const selected = QUESTIONS[key].options.find(
      (option) => option.id === state.answers[key]?.optionId,
    )
    const option = selected ?? QUESTIONS[key].options[0]!
    return option.summaryText ?? option.text
  }
  const pagesFor = (): string[] => {
    const selected = QUESTIONS.pages.options.find(
      (option) => option.id === state.answers.pages?.optionId,
    )
    const option = selected ?? QUESTIONS.pages.options[0]!
    return (option.pages ?? ['首页']).slice(0, PAGE_LIMIT)
  }
  return {
    message: state.message?.trim() || '个人主页',
    audience: summaryFor('audience'),
    style: summaryFor('style'),
    pages: pagesFor(),
    data: summaryFor('data'),
    interaction: summaryFor('interaction'),
  }
}
