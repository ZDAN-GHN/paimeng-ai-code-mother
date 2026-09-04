// 五维访谈（Issue #7）：受众/风格/页面清单/数据需求/交互，每维模型生成 2-4 选项的选择题，最多 2 轮；
// 信息足够（各维均已作答）直接收束进入线框，不硬凑轮数（docs/ts_agent/architecture.md §4）。
// 脚本化实现：问题集与收敛规则确定性生成，接口即「模型生成题目」的契约；接入真实模型时只替换
// 题目生成与收敛判断（buildRound1Questions / buildRound2FollowUps / decideNextRound），其余不动。
// 访谈状态经 run.context JSON 持久化（跨请求存活，HITL 不以 HTTP 连接存续为前提）。
import { PAGE_LIMIT } from './wireframe.js'

// 固定 5 维（架构 §4：受众/风格/页面清单/数据需求/交互）
export const INTERVIEW_DIMENSIONS = ['audience', 'style', 'pages', 'data', 'interaction'] as const
export type InterviewDimension = (typeof INTERVIEW_DIMENSIONS)[number]

// 访谈轮次硬上限（架构 §4：最多 2 轮，信息足够时跳过剩余轮次）
export const MAX_INTERVIEW_ROUNDS = 2

export interface InterviewOption {
  id: string
  text: string
}

export interface InterviewQuestion {
  // 维度 key（audience/style/pages/data/interaction）
  key: InterviewDimension
  // 维度中文名（前端展示用）
  dimension: string
  question: string
  options: InterviewOption[]
}

// 用户对某个维度的作答（单选；optionId 可空表示跳过）
export interface InterviewAnswer {
  key: InterviewDimension
  optionId?: string
  text?: string
}

// 访谈状态（持久化于 run.context.interview，跨请求存活）
export interface InterviewState {
  // 当前进行到的轮次（0 = 尚未进入；1/2 = 进行中或已完成的轮次）
  round: number
  // 用户最初的需求描述（访谈与线框的输入锚）
  message?: string
  // 各维度的作答（key → 选项 id + 补充说明）
  answers: Partial<Record<InterviewDimension, { optionId: string; text?: string }>>
  // 访谈是否已收束（信息足够或已达 2 轮）
  complete: boolean
}

// 访谈结论（喂线框生成的收敛结果）
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

// 脚本化题目集：每维一道 2-4 选项选择题（真实模型替换点）
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
      { id: 'single', text: '单页（只有首页）' },
      { id: 'home-detail', text: '首页 + 详情页' },
      { id: 'home-list-detail', text: '首页 + 列表 + 详情' },
      { id: 'full', text: '完整站点（首页+列表+详情+关于+联系）' },
    ],
  },
  data: {
    question: '需要展示什么内容 / 数据？',
    options: [
      { id: 'light', text: '少量图文介绍' },
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

// 第 1 轮题目：五个维度各一道选择题（message 供真实模型生成题目，脚本化暂不参与）
export function buildRound1Questions(message?: string): InterviewQuestion[] {
  void message
  return INTERVIEW_DIMENSIONS.map((key) => ({ key, dimension: DIMENSION_LABELS[key], ...QUESTIONS[key] }))
}

// 第 2 轮追问：仅对尚未作答的维度补问（脚本化收敛规则：缺信息才追问，不硬凑轮数）
export function buildRound2FollowUps(state: InterviewState): InterviewQuestion[] {
  return INTERVIEW_DIMENSIONS.filter((key) => !state.answers[key]?.optionId)
    .map((key) => ({ key, dimension: DIMENSION_LABELS[key], ...QUESTIONS[key] }))
}

// 合并本轮答案到访谈状态（保留既有作答，仅覆盖本轮出现的维度）
export function mergeAnswers(state: InterviewState, answers: InterviewAnswer[] | undefined): InterviewState {
  const merged: InterviewState = { ...state, answers: { ...state.answers } }
  for (const answer of answers ?? []) {
    if (!answer || !answer.key) continue
    merged.answers[answer.key] = { optionId: answer.optionId ?? '', text: answer.text }
  }
  return merged
}

// 收敛判断：各维均已作答（信息足够）→ 收束；否则进入下一轮（最多 2 轮）
export function decideNextRound(state: InterviewState): { complete: boolean; questions?: InterviewQuestion[] } {
  const answeredAll = INTERVIEW_DIMENSIONS.every((key) => Boolean(state.answers[key]?.optionId))
  if (answeredAll || state.round >= MAX_INTERVIEW_ROUNDS) {
    return { complete: true }
  }
  return { complete: false, questions: buildRound2FollowUps(state) }
}

// 选项 id → 人话结论的映射（脚本化收敛；缺失维度落到默认值）
const AUDIENCE_TEXT: Record<string, string> = {
  personal: '个人 / 个人品牌',
  merchant: '小微商家',
  creator: '内容创作者',
  local: '本地服务机构',
}
const STYLE_TEXT: Record<string, string> = {
  modern: '简约现代',
  vivid: '活泼多彩',
  business: '商务稳重',
  artistic: '文艺清新',
}
const PAGE_SETS: Record<string, string[]> = {
  single: ['首页'],
  'home-detail': ['首页', '详情'],
  'home-list-detail': ['首页', '列表', '详情'],
  full: ['首页', '列表', '详情', '关于', '联系'],
}
const DATA_TEXT: Record<string, string> = {
  light: '以少量图文介绍为主',
  gallery: '图文 + 作品 / 商品列表',
  form: '图文 + 列表 + 预约 / 表单',
  rich: '内容较丰富（含详情与多分类）',
}
const INTERACTION_TEXT: Record<string, string> = {
  view: '以浏览为主',
  'view-form': '浏览 + 表单提交',
  'view-form-map': '浏览 + 表单 + 地图',
  full: '完整交互（搜索 / 登录 / 收藏）',
}

// 由访谈状态生成收敛结论（喂线框生成）；缺失维度落到默认值，页面数上限 5
export function buildSummary(state: InterviewState): InterviewSummary {
  const pages = (PAGE_SETS[state.answers.pages?.optionId ?? 'single'] ?? ['首页']).slice(0, PAGE_LIMIT)
  return {
    message: state.message?.trim() || '个人主页',
    audience: AUDIENCE_TEXT[state.answers.audience?.optionId ?? 'personal'] ?? '个人 / 个人品牌',
    style: STYLE_TEXT[state.answers.style?.optionId ?? 'modern'] ?? '简约现代',
    pages,
    data: DATA_TEXT[state.answers.data?.optionId ?? 'light'] ?? '以少量图文介绍为主',
    interaction: INTERACTION_TEXT[state.answers.interaction?.optionId ?? 'view'] ?? '以浏览为主',
  }
}
