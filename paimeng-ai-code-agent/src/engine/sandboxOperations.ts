import { randomUUID } from 'node:crypto'

import {
  type ExecutionCapabilities,
  isWritablePath,
} from '../protocol/executionCapabilities.js'
import type { CommandResult } from './platformClient.js'
import { assertAbsoluteContainerPath, quoteShellArgument } from './shellQuote.js'

/**
 * 把 Pi 工具的文件与命令操作改道进 Sandbox（Issue #77 / T-05，计划步骤 34）。
 *
 * 全部经 Platform 的 `/commands` 端点合成：Runtime 不持有 Docker 句柄，也不碰宿主文件系统。
 * 这样做的收益不只是隔离——工作区的每一次读写都落在 Java 侧同一个 fence + 归属 + 审计收口点，
 * 不需要为文件操作再复制一套授权逻辑。
 *
 * 代价与已知限制：
 * - 每次操作是一次 HTTP + 一次容器 exec，延迟高于本地 fs。生成应用是 KB 级、文件数十个，可接受。
 * - 内容经 base64 传输（膨胀 4/3），嵌在 JSON body 里。
 * - `/commands` 返回缓冲结果，因此 `bash` 的 `onData` 在命令结束时被调用一次，不是流式。
 * - `grep` 工具不可用本模块改道：其 ripgrep 是无条件本地执行的，装配它会让模型读到
 *   Runtime 宿主的文件。装配清单与理由见 `../pi/piEngineAdapter.ts`。
 */

/** 文件类操作的超时。它们都是单次 shell 内建命令，不需要与 `npm install` 同级的上限。 */
const FILE_OPERATION_TIMEOUT_SECONDS = 30

/** `readdir` / `listFilesForGlob` 的条目上限。防止一个失控的工作区把响应体撑爆。 */
const MAX_DIRECTORY_ENTRIES = 5_000

/**
 * 本模块需要的唯一 Platform 能力：在容器内执行一条命令。
 *
 * 刻意不依赖具体的 `PlatformClient`：它含私有字段，会让假实现无法结构化替代，
 * 而本模块的转义与路径判定正是最需要单元验证的部分。
 */
export interface SandboxCommandGateway {
  executeCommand(input: {
    applicationId: string
    runId: string
    fenceToken: string
    command: string
    timeoutSeconds: number
    requestId: string
    signal?: AbortSignal
  }): Promise<CommandResult>
}

export class SandboxOperationError extends Error {
  public readonly operation: string
  public readonly exitCode?: number | undefined

  public constructor(options: {
    operation: string
    message: string
    exitCode?: number
    cause?: unknown
  }) {
    super(options.message, { cause: options.cause })
    this.name = 'SandboxOperationError'
    this.operation = options.operation
    this.exitCode = options.exitCode
  }
}

export interface SandboxOperationsOptions {
  readonly client: SandboxCommandGateway
  readonly applicationId: string
  readonly runId: string
  /**
   * fence token 的读取器，而不是 fence token 本身。
   *
   * AD-005：Lease 是 Platform 的权威事实，续租响应可能带回新的 fence。构造时固化一个值，
   * 就会在续租后继续出示陈旧凭据——请求会被 Platform 正确拒绝，但失败点离原因很远，
   * 表现为「跑了一半突然全部写入被拒」。按使用时读取，让凭据永远跟随最新的权威事实。
   */
  readonly readFenceToken: () => string
  readonly capabilities: ExecutionCapabilities
}

/**
 * Sandbox 内的操作集合。
 *
 * 刻意不实现 Pi 的某个具体 `operations` 接口：同名方法在不同工具里签名不同
 * （`read.readFile` 要 `Buffer`，`grep.readFile` 要 `string`），由装配处各取所需。
 */
export class SandboxOperations {
  private readonly client: SandboxCommandGateway
  private readonly applicationId: string
  private readonly runId: string
  private readonly readFenceToken: () => string
  private readonly capabilities: ExecutionCapabilities

  public constructor(options: SandboxOperationsOptions) {
    this.client = options.client
    this.applicationId = options.applicationId
    this.runId = options.runId
    this.readFenceToken = options.readFenceToken
    this.capabilities = options.capabilities
  }

  public get workspacePath(): string {
    return this.capabilities.workspacePath
  }

  /** 读文件。经 base64 传输，因此二进制内容也是安全的。 */
  public async readFileAsBuffer(absolutePath: string): Promise<Buffer> {
    assertAbsoluteContainerPath(absolutePath)
    const quotedPath = quoteShellArgument(absolutePath)
    // -w0 关掉换行折叠：折叠后的 base64 仍可解码，但会白白增大响应体
    const result = await this.run('readFile', `base64 -w0 -- ${quotedPath}`)
    this.requireSuccess('readFile', result, `Failed to read ${absolutePath}`)
    return Buffer.from(result.stdout, 'base64')
  }

  public async readFileAsText(absolutePath: string): Promise<string> {
    return (await this.readFileAsBuffer(absolutePath)).toString('utf8')
  }

  /**
   * 写文件。
   *
   * 先查可写区：Platform 下发的 `writablePaths` 是权威事实，提前拒绝比等只读根文件系统
   * 报出一个语义模糊的 shell 错误更清楚。
   */
  public async writeFile(absolutePath: string, content: string): Promise<void> {
    assertAbsoluteContainerPath(absolutePath)
    this.requireWritable('writeFile', absolutePath)

    const encodedContent = Buffer.from(content, 'utf8').toString('base64')
    const quotedPath = quoteShellArgument(absolutePath)
    const parentDirectory = containerDirname(absolutePath)
    const command =
      `mkdir -p -- ${quoteShellArgument(parentDirectory)} && ` +
      `printf '%s' ${quoteShellArgument(encodedContent)} | base64 -d > ${quotedPath}`

    const result = await this.run('writeFile', command)
    this.requireSuccess('writeFile', result, `Failed to write ${absolutePath}`)
  }

  public async mkdir(absolutePath: string): Promise<void> {
    assertAbsoluteContainerPath(absolutePath)
    this.requireWritable('mkdir', absolutePath)
    const result = await this.run('mkdir', `mkdir -p -- ${quoteShellArgument(absolutePath)}`)
    this.requireSuccess('mkdir', result, `Failed to create ${absolutePath}`)
  }

  /** 可读性检查。失败必须抛错——Pi 的 `access` 契约是「不可读则 throw」。 */
  public async requireReadable(absolutePath: string): Promise<void> {
    assertAbsoluteContainerPath(absolutePath)
    const result = await this.run('access', `test -r ${quoteShellArgument(absolutePath)}`)
    this.requireSuccess('access', result, `Path is not readable: ${absolutePath}`)
  }

  /** 读写性检查，供 `edit` 工具使用：它读后即写，提前失败好过写到一半。 */
  public async requireReadableAndWritable(absolutePath: string): Promise<void> {
    assertAbsoluteContainerPath(absolutePath)
    this.requireWritable('access', absolutePath)
    const quotedPath = quoteShellArgument(absolutePath)
    const result = await this.run('access', `test -r ${quotedPath} && test -w ${quotedPath}`)
    this.requireSuccess('access', result, `Path is not readable and writable: ${absolutePath}`)
  }

  /** 存在性检查。不存在是正常返回值而非错误，所以这里只看退出码。 */
  public async exists(absolutePath: string): Promise<boolean> {
    assertAbsoluteContainerPath(absolutePath)
    const result = await this.run('exists', `test -e ${quoteShellArgument(absolutePath)}`)
    return result.exitCode === 0
  }

  /** 目录判定。路径不存在时抛错——Pi 的 `stat` 与 `isDirectory` 契约都是「不存在则 throw」。 */
  public async isDirectory(absolutePath: string): Promise<boolean> {
    assertAbsoluteContainerPath(absolutePath)
    const quotedPath = quoteShellArgument(absolutePath)
    // 一次 exec 同时回答"存在吗"和"是目录吗"，省一个来回：
    // 2 = 不存在，1 = 存在但非目录，0 = 目录
    const result = await this.run(
      'isDirectory',
      `if [ ! -e ${quotedPath} ]; then exit 2; fi; if [ -d ${quotedPath} ]; then exit 0; else exit 1; fi`,
    )
    if (result.exitCode === 2) {
      throw new SandboxOperationError({
        operation: 'isDirectory',
        message: `Path not found: ${absolutePath}`,
        exitCode: result.exitCode,
      })
    }
    return result.exitCode === 0
  }

  /** 列目录。`-A` 含隐藏项但不含 `.`/`..`；`-1` 保证一行一项，便于按行切分。 */
  public async readdir(absolutePath: string): Promise<string[]> {
    assertAbsoluteContainerPath(absolutePath)
    const result = await this.run(
      'readdir',
      `ls -A -1 -- ${quoteShellArgument(absolutePath)} | head -n ${MAX_DIRECTORY_ENTRIES}`,
    )
    this.requireSuccess('readdir', result, `Failed to list ${absolutePath}`)
    return splitNonEmptyLines(result.stdout)
  }

  /**
   * 枚举文件供 `find` 工具做 glob 匹配。
   *
   * 刻意只在容器内做「列出候选」，匹配留给调用方在 Runtime 内完成：把 glob 语义翻译成
   * shell 通配或 `find -name` 会引入两套不一致的匹配规则，而不一致的搜索结果会让模型
   * 反复找同一个文件。列举是确定的，匹配是纯函数。
   */
  public async listFilesForGlob(searchPath: string, limit: number): Promise<string[]> {
    assertAbsoluteContainerPath(searchPath)
    const boundedLimit = Math.min(Math.max(limit, 1), MAX_DIRECTORY_ENTRIES)
    const result = await this.run(
      'listFiles',
      `find ${quoteShellArgument(searchPath)} -type f | head -n ${boundedLimit}`,
    )
    this.requireSuccess('listFiles', result, `Failed to enumerate ${searchPath}`)
    return splitNonEmptyLines(result.stdout)
  }

  /**
   * 执行命令，供 `bash` 工具使用。
   *
   * `onData` 只会被调用一次（命令结束时）：Platform 在容器内做了流式桥接，但 REST 响应是
   * 缓冲的。语义仍然正确——输出完整、顺序正确——只是不增量。
   *
   * `env` 以 `export` 前缀注入。每个值都经转义，因此环境变量值里的元字符不会变成命令。
   */
  public async exec(
    command: string,
    options: {
      onData: (data: Buffer) => void
      signal?: AbortSignal
      timeout?: number
      env?: NodeJS.ProcessEnv
      /** 工作目录。容器有固定 workdir，模型要求子目录时以 `cd` 前缀实现。 */
      cwd?: string
    },
  ): Promise<{ exitCode: number | null }> {
    if (options.signal?.aborted === true) {
      throw new SandboxOperationError({ operation: 'exec', message: 'Operation aborted' })
    }

    const timeoutSeconds = this.resolveCommandTimeoutSeconds(options.timeout)
    const result = await this.client.executeCommand({
      applicationId: this.applicationId,
      runId: this.runId,
      fenceToken: this.readFenceToken(),
      command: prefixWorkingDirectory(
        prefixEnvironmentExports(command, options.env),
        options.cwd,
      ),
      timeoutSeconds,
      requestId: randomUUID(),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })

    if (result.stdout.length > 0) {
      options.onData(Buffer.from(result.stdout, 'utf8'))
    }
    if (result.stderr.length > 0) {
      options.onData(Buffer.from(result.stderr, 'utf8'))
    }

    return { exitCode: result.exitCode }
  }

  /** 把工具给的毫秒超时收敛到 Platform 允许的秒级区间。 */
  private resolveCommandTimeoutSeconds(timeoutMs?: number): number {
    if (timeoutMs === undefined || timeoutMs <= 0) {
      return this.capabilities.defaultCommandTimeoutSeconds
    }
    const requestedSeconds = Math.ceil(timeoutMs / 1000)
    return Math.min(Math.max(requestedSeconds, 1), this.capabilities.maxCommandTimeoutSeconds)
  }

  private requireWritable(operation: string, absolutePath: string): void {
    if (!isWritablePath(this.capabilities, absolutePath)) {
      throw new SandboxOperationError({
        operation,
        message:
          `Path is outside the writable area: ${absolutePath}. ` +
          `Writable paths: ${this.capabilities.writablePaths.join(', ')}`,
      })
    }
  }

  private async run(operation: string, command: string): Promise<CommandResult> {
    return this.client.executeCommand({
      applicationId: this.applicationId,
      runId: this.runId,
      fenceToken: this.readFenceToken(),
      command,
      timeoutSeconds: FILE_OPERATION_TIMEOUT_SECONDS,
      requestId: randomUUID(),
    })
  }

  private requireSuccess(operation: string, result: CommandResult, message: string): void {
    if (result.exitCode !== 0) {
      throw new SandboxOperationError({
        operation,
        exitCode: result.exitCode,
        message: `${message} (exit ${result.exitCode})${
          result.stderr.trim().length > 0 ? `: ${result.stderr.trim()}` : ''
        }`,
      })
    }
  }
}

/** 容器内路径的父目录。恒用 POSIX 分隔符：容器是 Linux，与 Runtime 宿主的平台无关。 */
function containerDirname(absolutePath: string): string {
  const lastSeparatorIndex = absolutePath.lastIndexOf('/')
  return lastSeparatorIndex <= 0 ? '/' : absolutePath.slice(0, lastSeparatorIndex)
}

function splitNonEmptyLines(output: string): string[] {
  return output.split('\n').filter((line) => line.length > 0)
}

function prefixEnvironmentExports(command: string, env?: NodeJS.ProcessEnv): string {
  if (env === undefined) {
    return command
  }

  const exports = Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    // 变量名只允许 shell 标识符字符：名字位无法用引号保护，含元字符的名字必须丢弃而非转义
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => `export ${name}=${quoteShellArgument(value)}`)

  return exports.length === 0 ? command : `${exports.join('; ')}; ${command}`
}

/**
 * 以 `cd` 前缀实现工作目录。
 *
 * `&&` 而非 `;`：目标目录不存在时必须整体失败。用 `;` 会让命令在容器 workdir 里
 * 静默执行——一个"成功"但写错了位置的结果，比一个失败危险得多。
 */
function prefixWorkingDirectory(command: string, cwd?: string): string {
  if (cwd === undefined || cwd.length === 0) {
    return command
  }

  assertAbsoluteContainerPath(cwd)
  return `cd ${quoteShellArgument(cwd)} && ${command}`
}
