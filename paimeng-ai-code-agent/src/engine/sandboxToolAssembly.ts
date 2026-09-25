import path from 'node:path'

import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'

import type { SandboxOperations } from './sandboxOperations.js'

/**
 * 把 Pi 内置工具改道进 Sandbox（Issue #77 / T-05，计划步骤 33-34）。
 *
 * 这是本 Ticket 隔离保证真正落地的地方。装配规则不是风格问题，错一处就等于把
 * Runtime 宿主的文件系统交给模型：
 *
 * 1. 会话必须以 `noTools: 'all'` 创建。内置工具的默认 `operations` 是**本地文件系统**，
 *    只要有一个默认实例被启用，模型就能读写 Runtime 宿主。
 * 2. 只注册本模块返回的定义。它们的 `operations` 全部指向 `SandboxOperations`。
 * 3. `grep` 工具不可装配。其 `GrepOperations` 只有 `isDirectory` 与 `readFile`（供上下文行），
 *    **搜索本身由本地 ripgrep 执行且无法改道**。装配它等于让模型搜索宿主文件系统。
 *    模型需要搜索时用 `bash` 工具在容器内执行 grep。
 * 4. `bash` 工具须禁用会话环境并清空 spawn 环境。SDK 的
 *    `exposeSessionEnvironment: false` 只去掉 PI_*，不会去掉继承的 provider key。
 */

/** 装配后可用的工具名。用于向 `createAgentSession` 传显式 allowlist，双重保险。 */
export const SANDBOX_TOOL_NAMES = ['read', 'edit', 'write', 'bash', 'find', 'ls'] as const

/**
 * 明确排除的工具名。
 *
 * `noTools: 'all'` 已经全关，这里是第二道显式围栏：若将来有人改动会话创建参数，
 * 显式 denylist 让"grep 不可用"这件事有一处可 grep 到的声明，而不是隐含在某个默认值里。
 */
export const EXCLUDED_TOOL_NAMES = ['grep', 'powershell'] as const

export function createSandboxToolDefinitions(
  operations: SandboxOperations,
): ToolDefinition[] {
  const containerWorkspacePath = operations.workspacePath

  const readDefinition = createReadToolDefinition(containerWorkspacePath, {
    operations: {
      readFile: async (absolutePath) => operations.readFileAsBuffer(absolutePath),
      access: async (absolutePath) => operations.requireReadable(absolutePath),
      // 恒返回 null：生成应用的工作区里没有需要模型看图的场景，而默认实现会读
      // Runtime 宿主的文件做 MIME 嗅探。显式关掉比依赖"可选字段未提供时不会走本地"更可靠。
      detectImageMimeType: async () => null,
    },
  })

  const editDefinition = createEditToolDefinition(containerWorkspacePath, {
    operations: {
      readFile: async (absolutePath) => operations.readFileAsBuffer(absolutePath),
      writeFile: async (absolutePath, content) => operations.writeFile(absolutePath, content),
      // edit 的 access 语义是"可读且可写"：它读后即写，只验可读会让失败推迟到写入中途
      access: async (absolutePath) => operations.requireReadableAndWritable(absolutePath),
    },
  })

  const writeDefinition = createWriteToolDefinition(containerWorkspacePath, {
    operations: {
      writeFile: async (absolutePath, content) => operations.writeFile(absolutePath, content),
      mkdir: async (directoryPath) => operations.mkdir(directoryPath),
    },
  })

  const bashDefinition = createBashToolDefinition(containerWorkspacePath, {
    // SDK 仍会把宿主机环境传给自定义 operations；容器只使用镜像自身的环境。
    exposeSessionEnvironment: false,
    spawnHook: (context) => ({ ...context, env: {} }),
    operations: {
      exec: async (command, commandCwd, execOptions) =>
        operations.exec(command, { ...execOptions, cwd: commandCwd }),
    },
  })

  const findDefinition = createFindToolDefinition(containerWorkspacePath, {
    operations: {
      exists: async (absolutePath) => operations.exists(absolutePath),
      glob: async (pattern, globCwd, globOptions) =>
        matchGlobInSandbox(operations, pattern, globCwd, globOptions),
    },
  })

  const lsDefinition = createLsToolDefinition(containerWorkspacePath, {
    operations: {
      exists: async (absolutePath) => operations.exists(absolutePath),
      stat: async (absolutePath) => {
        // 契约是"不存在则 throw"，由 isDirectory 负责；这里只把布尔包成 stat 形状
        const isDirectory = await operations.isDirectory(absolutePath)
        return { isDirectory: () => isDirectory }
      },
      readdir: async (absolutePath) => operations.readdir(absolutePath),
    },
  })

  // 必须经 defineTool 包一层。
  //
  // 原因是 SDK 自身的类型形状：工厂返回 `ToolDefinition<具体 schema, 具体 details>`，
  // 而 `customTools` 要的是 `ToolDefinition[]`（默认泛型 `<TSchema, unknown, any>`）。
  // `renderCall(args: 具体类型)` 在 args 位逆变，因此具体定义无法直接赋给通用数组。
  // `defineTool` 的返回类型交叉了 SDK 内部的 `AnyToolDefinition`（types.d.ts:379、387），
  // 正是为此准备的官方逃逸口。
  //
  // 这里不用类型断言：`.agents/rules/typescript.md` 禁止断言，而断言还会顺手
  // 掩盖掉真正的 operations 形状错误——那类错误一旦被掩盖，就变成"模型读到宿主文件"。
  return [
    defineTool(readDefinition),
    defineTool(editDefinition),
    defineTool(writeDefinition),
    defineTool(bashDefinition),
    defineTool(findDefinition),
    defineTool(lsDefinition),
  ]
}

/**
 * glob 匹配：容器内枚举，Runtime 内匹配。
 *
 * 刻意不把 glob 翻译成 shell 通配或 `find -name`：那会引入两套不一致的匹配规则，
 * 而搜索结果不一致会让模型反复"找不到"同一个文件。枚举是确定的，匹配是纯函数。
 *
 * 匹配器用 Node 内置 `path.matchesGlob`（Node 22+），不引入新依赖。
 */
async function matchGlobInSandbox(
  operations: SandboxOperations,
  pattern: string,
  globCwd: string,
  globOptions: { ignore: string[]; limit: number },
): Promise<string[]> {
  // 多取一些候选再过滤：limit 是"匹配结果"的上限，不是"候选文件"的上限。
  // 取等量候选会在工作区文件多于 limit 时漏掉本该命中的文件。
  const candidateLimit = Math.min(globOptions.limit * 20, 5_000)
  const absolutePaths = await operations.listFilesForGlob(globCwd, candidateLimit)

  const matchedPaths: string[] = []
  for (const absolutePath of absolutePaths) {
    // 容器是 Linux，恒用 POSIX 语义；不能用 path.relative（会随 Runtime 宿主平台变化）
    const relativePath = toRelativePosixPath(absolutePath, globCwd)
    if (!path.matchesGlob(relativePath, pattern)) {
      continue
    }
    if (globOptions.ignore.some((ignorePattern) => path.matchesGlob(relativePath, ignorePattern))) {
      continue
    }

    matchedPaths.push(relativePath)
    if (matchedPaths.length >= globOptions.limit) {
      break
    }
  }

  return matchedPaths
}

function toRelativePosixPath(absolutePath: string, basePath: string): string {
  const normalizedBase = basePath.endsWith('/') ? basePath : `${basePath}/`
  return absolutePath.startsWith(normalizedBase)
    ? absolutePath.slice(normalizedBase.length)
    : absolutePath
}
