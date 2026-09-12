import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createApprovalService, type ApprovalService } from '../approval/index.js'
import type { SessionStore } from '../session/store.js'
import type { FileTools, FileToolResult } from '../generation/tools/fileTools.js'
import type { ImageTools, ImageToolResult } from '../generation/tools/imageTools.js'

const questionOptionSchema = z.object({ id: z.string().min(1), text: z.string().min(1) })
const questionSchema = z.object({
  key: z.string().min(1), dimension: z.string().min(1), question: z.string().min(1),
  options: z.array(questionOptionSchema).min(2).max(4),
})
const askUserInputSchema = z.object({ questions: z.array(questionSchema).min(1), round: z.number().int().min(1) })
const wireframeInputSchema = z.object({
  relativeUrl: z.string().regex(/^wireframe\/[^/]+\.html$/),
  pageCount: z.number().int().min(1).max(5), version: z.string().min(1), content: z.string().min(1),
})
const requestGenerationInputSchema = z.object({ reason: z.string().min(1), estimatedCredits: z.number().int().nonnegative() })
const readFileInputSchema = z.object({ relativeFilePath: z.string().min(1) })
const readDirInputSchema = z.object({ relativeDirPath: z.string().min(1).optional() })
const searchImagesInputSchema = z.object({ query: z.string().min(1) })

export interface TurnToolContext {
  appId: string
  userId: string
  turnId: string
  sessionStore: SessionStore
  files: Pick<FileTools, 'writeFile' | 'readFile' | 'readDir'>
  images: Pick<ImageTools, 'searchContentImages'>
  approvalService?: ApprovalService
  batchSeq?: number
}

export interface AwaitingUserResult {
  type: 'awaiting_user'
  reason: 'asked' | 'wireframe' | 'approval'
  events: Array<{ kind: string; source: 'model' | 'system'; payload: Record<string, unknown> }>
}

export interface TurnTool<Input, Output> {
  description: string
  inputSchema: z.ZodType<Input>
  execute(input: unknown): Promise<Output>
}

function eventContext(context: TurnToolContext) {
  return { appId: context.appId, userId: context.userId, turnId: context.turnId, batchSeq: context.batchSeq ?? 1 }
}

async function appendModelEvent(
  context: TurnToolContext,
  event: { kind: 'clarify/asked' | 'wireframe/produced' | 'generation/proposed'; source: 'model'; payload: Record<string, unknown> },
): Promise<void> {
  await context.sessionStore.appendBatch({ ...eventContext(context), events: [event] })
}

export function buildSessionTurnTools(context: TurnToolContext) {
  const approval = context.approvalService ?? createApprovalService(context.sessionStore)
  const askUser: TurnTool<z.infer<typeof askUserInputSchema>, AwaitingUserResult> = {
    description: '向用户提出结构化澄清问题；不会创建 run、扣除积分或执行付费动作。',
    inputSchema: askUserInputSchema,
    async execute(input) {
      const { questions, round } = askUserInputSchema.parse(input)
      const payload = { itemKeys: questions.map((question) => question.key) }
      await appendModelEvent(context, { kind: 'clarify/asked', source: 'model', payload })
      return { type: 'awaiting_user', reason: 'asked', events: [{ kind: 'clarify/asked', source: 'model', payload: { ...payload, questions, round } }] }
    },
  }

  const writeWireframe: TurnTool<z.infer<typeof wireframeInputSchema>, AwaitingUserResult & { wireframe: { relativeUrl: string; pageCount: number; version: string } }> = {
    description: '将线框 HTML 写入 wireframe 目录并等待用户；仅允许线框文件，不执行代码生成。',
    inputSchema: wireframeInputSchema,
    async execute(input) {
      const { relativeUrl, pageCount, version, content } = wireframeInputSchema.parse(input)
      await context.files.writeFile(relativeUrl, content)
      const payload = { relativeUrl, pageCount, version }
      await appendModelEvent(context, { kind: 'wireframe/produced', source: 'model', payload })
      return { type: 'awaiting_user', reason: 'wireframe', wireframe: payload, events: [{ kind: 'wireframe/produced', source: 'model', payload }] }
    },
  }

  const requestGeneration: TurnTool<z.infer<typeof requestGenerationInputSchema>, AwaitingUserResult & { approvalId: string }> = {
    description: '提议开始生成并请求用户审批；不会创建 run、冻结积分、生成代码、构建、部署或修改任意非线框文件。',
    inputSchema: requestGenerationInputSchema,
    async execute(input) {
      const { reason, estimatedCredits } = requestGenerationInputSchema.parse(input)
      const approvalId = `ap-${randomUUID()}`
      const base = eventContext(context)
      const proposal = { reason, estimatedCredits }
      await context.sessionStore.appendBatch({ ...base, events: [{ kind: 'generation/proposed', source: 'model', payload: proposal }] })
      await approval.request({ ...base, action: 'start_generation', approvalId })
      return {
        type: 'awaiting_user', reason: 'approval', approvalId,
        events: [
          { kind: 'generation/proposed', source: 'model', payload: proposal },
          { kind: 'approval/asked', source: 'system', payload: { approvalId, action: 'start_generation', turnId: context.turnId } },
        ],
      }
    },
  }

  const readFile: TurnTool<z.infer<typeof readFileInputSchema>, FileToolResult> = {
    description: '只读读取工作区文件，不修改工作区。', inputSchema: readFileInputSchema,
    execute: (input) => {
      const { relativeFilePath } = readFileInputSchema.parse(input)
      return context.files.readFile(relativeFilePath)
    },
  }
  const readDir: TurnTool<z.infer<typeof readDirInputSchema>, FileToolResult> = {
    description: '只读查看工作区目录结构，不修改工作区。', inputSchema: readDirInputSchema,
    execute: (input) => {
      const { relativeDirPath } = readDirInputSchema.parse(input)
      return context.files.readDir(relativeDirPath)
    },
  }
  const searchContentImages: TurnTool<z.infer<typeof searchImagesInputSchema>, ImageToolResult> = {
    description: '只读搜索内容图片，不执行代码生成、构建或部署。', inputSchema: searchImagesInputSchema,
    execute: (input) => {
      const { query } = searchImagesInputSchema.parse(input)
      return context.images.searchContentImages(query)
    },
  }
  return { ask_user: askUser, write_wireframe: writeWireframe, request_generation: requestGeneration, readFile, readDir, searchContentImages }
}

export type SessionTurnTools = ReturnType<typeof buildSessionTurnTools>
export { askUserInputSchema, wireframeInputSchema, requestGenerationInputSchema }
