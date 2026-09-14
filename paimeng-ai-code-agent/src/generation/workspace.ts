import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'

export class WorkspacePathError extends Error {}

function realpathShallow(target: string): string {
  if (existsSync(target)) {
    try {
      return realpathSync(target)
    } catch {}
  }
  const parent = path.dirname(target)
  if (parent === target) return target
  return path.join(realpathShallow(parent), path.basename(target))
}

export function validateWorkspacePath(workspacePath: string, workspaceRoot: string): string {
  if (!workspacePath || !path.isAbsolute(workspacePath)) {
    throw new WorkspacePathError('workspacePath 必须是绝对路径')
  }
  const root = realpathShallow(path.resolve(workspaceRoot))
  const candidate = realpathShallow(path.resolve(workspacePath))

  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new WorkspacePathError(`workspacePath 必须位于 WORKSPACE_ROOT 之下: ${root}`)
  }
  return candidate
}
