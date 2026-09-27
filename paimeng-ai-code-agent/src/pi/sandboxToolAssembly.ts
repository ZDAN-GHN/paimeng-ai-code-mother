import path from 'node:path'

import { Type } from '@earendil-works/pi-ai'
import { truncateHead, truncateTail, type AgentTool } from '@earendil-works/pi-agent-core'
import { formatPatch, structuredPatch } from 'diff'

import type { SandboxOperations } from '../engine/sandboxOperations.js'

export const SANDBOX_TOOL_NAMES = ['read', 'edit', 'write', 'bash', 'find', 'ls'] as const

const MAX_RESULTS = 5_000
const readParameters = Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) })
const editParameters = Type.Object({ path: Type.String(), edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })) })
const writeParameters = Type.Object({ path: Type.String(), content: Type.String() })
const bashParameters = Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) })
const findParameters = Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) })
const lsParameters = Type.Object({ path: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) })

function toolText(text: string) {
  return { content: [{ type: 'text' as const, text }], details: undefined }
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Operation aborted')
}

function resolveSandboxPath(workspace: string, input: string): string {
  return path.posix.resolve(workspace, input)
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RESULTS) {
    throw new Error(`Limit must be an integer between 1 and ${MAX_RESULTS}`)
  }
  return value
}

/** Tool executions are local JS closures over SandboxOperations, never over host fs or a default ExecutionEnv. */
export function createSandboxToolDefinitions(operations: SandboxOperations) {
  const workspace = operations.workspacePath

  const read = {
    name: 'read', label: 'read',
    description: 'Read a text file in the container. Supports 1-based offset and line limit; returns at most 2000 lines or 50KB.',
    parameters: readParameters,
    async execute(_id: string, args: { path: string; offset?: number; limit?: number }, signal?: AbortSignal) {
      checkAborted(signal)
      const filePath = resolveSandboxPath(workspace, args.path)
      await operations.requireReadable(filePath)
      const text = (await operations.readFileAsBuffer(filePath)).toString('utf8')
      checkAborted(signal)
      const offset = positiveLimit(args.offset, 1)
      const limit = positiveLimit(args.limit, 2000)
      const lines = text.split('\n')
      if (offset > lines.length) throw new Error(`Offset ${offset} is beyond end of file`)
      const selected = lines.slice(offset - 1, offset - 1 + limit)
      const result = truncateHead(selected.join('\n'))
      if (result.firstLineExceedsLimit) {
        return { content: [{ type: 'text' as const, text: `[Line ${offset} exceeds 50KB limit. Use bash in the container to inspect it.]` }], details: { truncation: result } }
      }
      if (result.truncated) {
        const endLine = offset + result.outputLines - 1
        const text = `${result.content}\n\n[Showing lines ${offset}-${endLine} of ${lines.length} (${result.truncatedBy} limit). Use offset=${endLine + 1} to continue.]`
        return { content: [{ type: 'text' as const, text }], details: { truncation: result } }
      }
      if (offset - 1 + selected.length < lines.length) {
        const nextOffset = offset + selected.length
        return toolText(`${result.content}\n\n[${lines.length - nextOffset + 1} more lines in file. Use offset=${nextOffset} to continue.]`)
      }
      return toolText(result.content)
    },
  } satisfies AgentTool<typeof readParameters>

  const edit = {
    name: 'edit', label: 'edit',
    description: 'Apply unique, non-overlapping exact text replacements to a container file.',
    parameters: editParameters,
    async execute(_id: string, args: { path: string; edits: { oldText: string; newText: string }[] }, signal?: AbortSignal) {
      checkAborted(signal)
      const filePath = resolveSandboxPath(workspace, args.path)
      await operations.requireReadableAndWritable(filePath)
      const original = await operations.readFileAsText(filePath)
      const bom = original.startsWith('\uFEFF') ? '\uFEFF' : ''
      const body = original.slice(bom.length)
      const usesCrLf = body.includes('\r\n')
      const before = body.replace(/\r\n/g, '\n')
      checkAborted(signal)
      if (args.edits.length === 0) throw new Error('At least one edit is required')
      const locations = args.edits.map((change) => {
        const oldText = change.oldText.replace(/\r\n/g, '\n')
        if (!oldText) throw new Error('oldText cannot be empty')
        const start = before.indexOf(oldText)
        if (start === -1) throw new Error('Text to replace was not found')
        if (before.indexOf(oldText, start + 1) !== -1) throw new Error('Text to replace is not unique')
        return { start, end: start + oldText.length, change }
      }).sort((a, b) => a.start - b.start)
      for (let index = 1; index < locations.length; index++) {
        if (locations[index]!.start < locations[index - 1]!.end) throw new Error('Edits overlap')
      }
      let after = ''
      let cursor = 0
      for (const { start, end, change } of locations) {
        after += before.slice(cursor, start) + change.newText.replace(/\r\n/g, '\n')
        cursor = end
      }
      after += before.slice(cursor)
      const patch = structuredPatch(filePath, filePath, before, after)
      const patchText = formatPatch(patch)
      checkAborted(signal)
      await operations.writeFile(filePath, bom + (usesCrLf ? after.replace(/\n/g, '\r\n') : after))
      return {
        content: [{ type: 'text' as const, text: `Successfully replaced ${locations.length} block(s) in ${filePath}.` }],
        details: { diff: patchText, patch: patchText, firstChangedLine: patch.hunks[0]?.newStart },
      }
    },
  } satisfies AgentTool<typeof editParameters>

  const write = {
    name: 'write', label: 'write',
    description: 'Create or overwrite a file in the writable container workspace.',
    parameters: writeParameters,
    async execute(_id: string, args: { path: string; content: string }, signal?: AbortSignal) {
      checkAborted(signal)
      const filePath = resolveSandboxPath(workspace, args.path)
      await operations.writeFile(filePath, args.content)
      return toolText(`Successfully wrote to ${filePath}`)
    },
  } satisfies AgentTool<typeof writeParameters>

  const bash = {
    name: 'bash', label: 'bash',
    description: 'Run a command inside the container; timeout is measured in seconds.',
    parameters: bashParameters,
    async execute(_id: string, args: { command: string; timeout?: number }, signal?: AbortSignal) {
      checkAborted(signal)
      if (args.timeout !== undefined && (!Number.isFinite(args.timeout) || args.timeout <= 0)) {
        throw new Error('Timeout must be a positive number of seconds')
      }
      const chunks: Buffer[] = []
      const result = await operations.exec(args.command, {
        cwd: workspace, ...(signal === undefined ? {} : { signal }), env: {},
        ...(args.timeout === undefined ? {} : { timeout: args.timeout * 1000 }),
        onData: (chunk) => { chunks.push(chunk) },
      })
      checkAborted(signal)
      const output = truncateTail(Buffer.concat(chunks).toString('utf8')).content
      if (result.exitCode !== 0) {
        throw new Error(`${output ? `${output}\n\n` : ''}Command exited with code ${result.exitCode}`)
      }
      return toolText(`${output}${output ? '\n' : ''}Process exited with code ${result.exitCode}`)
    },
  } satisfies AgentTool<typeof bashParameters>

  const find = {
    name: 'find', label: 'find',
    description: 'Find files in the container by glob pattern. Returns paths relative to the search root.',
    parameters: findParameters,
    async execute(_id: string, args: { pattern: string; path?: string; limit?: number }, signal?: AbortSignal) {
      checkAborted(signal)
      const searchPath = resolveSandboxPath(workspace, args.path ?? '.')
      if (!(await operations.exists(searchPath))) throw new Error(`Path not found: ${searchPath}`)
      const limit = positiveLimit(args.limit, 1000)
      const paths = await matchGlobInSandbox(operations, args.pattern, searchPath, {
        ignore: ['**/node_modules/**', '**/.git/**'], limit,
      })
      checkAborted(signal)
      return toolText(paths.length ? truncateHead(paths.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER }).content
        : 'No files found matching pattern')
    },
  } satisfies AgentTool<typeof findParameters>

  const ls = {
    name: 'ls', label: 'ls',
    description: 'List directory entries in the container, alphabetically, with / for directories.',
    parameters: lsParameters,
    async execute(_id: string, args: { path?: string; limit?: number }, signal?: AbortSignal) {
      checkAborted(signal)
      const directory = resolveSandboxPath(workspace, args.path ?? '.')
      if (!(await operations.exists(directory))) throw new Error(`Path not found: ${directory}`)
      if (!(await operations.isDirectory(directory))) throw new Error(`Not a directory: ${directory}`)
      const limit = positiveLimit(args.limit, 500)
      const entries = (await operations.readdir(directory))
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      const output: string[] = []
      for (const entry of entries) {
        if (output.length >= limit) break
        checkAborted(signal)
        try {
          output.push(`${entry}${(await operations.isDirectory(path.posix.join(directory, entry))) ? '/' : ''}`)
        } catch {
          // Match the prior tool: an entry disappearing during enumeration is skipped.
        }
      }
      return toolText(output.length ? truncateHead(output.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER }).content
        : '(empty directory)')
    },
  } satisfies AgentTool<typeof lsParameters>

  return [read, edit, write, bash, find, ls]
}

async function matchGlobInSandbox(
  operations: SandboxOperations,
  pattern: string,
  globCwd: string,
  globOptions: { ignore: string[]; limit: number },
): Promise<string[]> {
  const candidateLimit = Math.min(globOptions.limit * 20, MAX_RESULTS)
  const absolutePaths = await operations.listFilesForGlob(globCwd, candidateLimit)
  const matchedPaths: string[] = []
  for (const absolutePath of absolutePaths) {
    const relativePath = path.posix.relative(globCwd, absolutePath)
    if (!relativePath || relativePath.startsWith('..') || path.posix.isAbsolute(relativePath)) continue
    if (!path.matchesGlob(relativePath, pattern)) continue
    if (globOptions.ignore.some((ignorePattern) => path.matchesGlob(relativePath, ignorePattern))) continue
    matchedPaths.push(relativePath)
    if (matchedPaths.length >= globOptions.limit) break
  }
  return matchedPaths
}
