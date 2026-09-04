// 工具注册表（Issue #8）：把工作区文件工具（读/写/改/删/列目录/退出）与图片四工具
// （内容图/插画/Logo/架构图）包装为 Vercel AI SDK tool 定义，供 coding 阶段 streamText 注册。
// 工具名对齐旧 Java 实现（camelCase）；执行函数闭包读取当前生成上下文（页面内容/工作区/图片工具实例）。
import { jsonSchema, tool } from 'ai'
import type { FileTools } from './fileTools.js'
import type { ImageTools } from './imageTools.js'
import { parseHtmlCode, toFiles } from '../codegen/parsing.js'

export interface ToolContext {
  // 文件工具集（绑定当前工作区）
  files: FileTools
  // 图片工具集（绑定单 run 配额）
  images: ImageTools
  // LLM 流式产出的原始文本（writeFile 写盘前经代码块解析出文件集）
  getPageContent: () => string
}

// 从解析结果取指定文件内容：writeFile 写盘即「解析后文件集」落盘；解析为空时回退原文
function fileContentByPath(context: ToolContext, relativeFilePath: string): string {
  const files = toFiles(parseHtmlCode(context.getPageContent()))
  return files[relativeFilePath] ?? context.getPageContent()
}

// 图片工具执行的统一包装：图片工具返回「资源数组或配额报错文本」，统一序列化为 JSON 字符串
async function runImageTool(fn: () => Promise<string | unknown[]>): Promise<string> {
  const result = await fn()
  return JSON.stringify(result)
}

export function buildTools(context: ToolContext) {
  return {
    // ── 工作区文件工具（对齐 Java ProjectFileWriteTool 等）──
    writeFile: tool({
      description: '把生成的页面文件写入工作区（自动创建父目录；内容来自代码块解析后的文件集）',
      inputSchema: jsonSchema({
        type: 'object',
        properties: { relativeFilePath: { type: 'string' } },
        required: ['relativeFilePath'],
      }),
      execute: async (input) => {
        const relativeFilePath = (input as { relativeFilePath: string }).relativeFilePath
        return context.files.writeFile(relativeFilePath, fileContentByPath(context, relativeFilePath))
      },
    }),

    readFile: tool({
      description: '读取工作区内指定文件的内容',
      inputSchema: jsonSchema({
        type: 'object',
        properties: { relativeFilePath: { type: 'string' } },
        required: ['relativeFilePath'],
      }),
      execute: async (input) => context.files.readFile((input as { relativeFilePath: string }).relativeFilePath),
    }),

    modifyFile: tool({
      description: '修改工作区内指定文件：用新内容替换旧内容',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          relativeFilePath: { type: 'string' },
          oldContent: { type: 'string' },
          newContent: { type: 'string' },
        },
        required: ['relativeFilePath', 'oldContent', 'newContent'],
      }),
      execute: async (input) => {
        const { relativeFilePath, oldContent, newContent } = input as { relativeFilePath: string; oldContent: string; newContent: string }
        return context.files.modifyFile(relativeFilePath, oldContent, newContent)
      },
    }),

    deleteFile: tool({
      description: '删除工作区内指定文件（重要文件受保护）',
      inputSchema: jsonSchema({
        type: 'object',
        properties: { relativeFilePath: { type: 'string' } },
        required: ['relativeFilePath'],
      }),
      execute: async (input) => context.files.deleteFile((input as { relativeFilePath: string }).relativeFilePath),
    }),

    readDir: tool({
      description: '读取工作区目录结构（忽略构建产物）',
      inputSchema: jsonSchema({
        type: 'object',
        properties: { relativeDirPath: { type: 'string' } },
      }),
      execute: async (input) => context.files.readDir((input as { relativeDirPath?: string }).relativeDirPath),
    }),

    exit: tool({
      description: '结束工具调用，输出最终结果',
      inputSchema: jsonSchema({ type: 'object', properties: {} }),
      execute: async () => '不要继续调用工具，可以输出最终结果了',
    }),

    // ── 图片四工具（对齐 Java langgraph4j/tools；配额 4 张/run）──
    searchContentImages: tool({
      description: '搜索内容相关的图片，用于网站内容展示（Pexels）',
      inputSchema: jsonSchema({
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      }),
      execute: async (input) => runImageTool(() => context.images.searchContentImages((input as { query: string }).query)),
    }),

    searchIllustrations: tool({
      description: '搜索插画图片，用于网站美化和装饰（Undraw）',
      inputSchema: jsonSchema({
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      }),
      execute: async (input) => runImageTool(() => context.images.searchIllustrations((input as { query: string }).query)),
    }),

    generateLogos: tool({
      description: '根据描述生成 Logo 设计图片，用于网站品牌标识（DashScope）',
      inputSchema: jsonSchema({
        type: 'object',
        properties: { description: { type: 'string' } },
        required: ['description'],
      }),
      execute: async (input) => runImageTool(() => context.images.generateLogos((input as { description: string }).description)),
    }),

    generateArchitectureDiagram: tool({
      description: '将 Mermaid 代码转换为架构图图片，用于展示系统结构和技术关系（mmdc）',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          mermaidCode: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['mermaidCode', 'description'],
      }),
      execute: async (input) => {
        const { mermaidCode, description } = input as { mermaidCode: string; description: string }
        return runImageTool(() => context.images.generateArchitectureDiagram(mermaidCode, description))
      },
    }),
  }
}

export type BuiltTools = ReturnType<typeof buildTools>
