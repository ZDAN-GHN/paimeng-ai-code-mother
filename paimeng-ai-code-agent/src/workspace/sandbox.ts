// 工作区沙箱校验：Java 计算绝对路径传入，Agent 校验不逃逸工作区根（移植自 Python Agent workspace/manager.py）
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'

// 校验失败（空值/非绝对路径/逃逸工作区根）→ 路由层转 400
export class WorkspacePathError extends Error {}

// 消解符号链接：已存在部分取 realpath；不存在部分对最深存在祖先 realpath 后拼回（对齐 Python Path.resolve 语义）
function realpathShallow(target: string): string {
  if (existsSync(target)) {
    try {
      return realpathSync(target)
    } catch {
      // 权限等原因读取失败时退化为词义路径，由前缀比较兜底
    }
  }
  const parent = path.dirname(target)
  if (parent === target) return target
  return path.join(realpathShallow(parent), path.basename(target))
}

// 校验工作区路径位于 workspaceRoot 之下，返回规范化后的绝对路径
export function validateWorkspacePath(workspacePath: string, workspaceRoot: string): string {
  if (!workspacePath || !path.isAbsolute(workspacePath)) {
    throw new WorkspacePathError('workspacePath 必须是绝对路径')
  }
  const root = realpathShallow(path.resolve(workspaceRoot))
  const candidate = realpathShallow(path.resolve(workspacePath))
  // 等于根本身放行（对应 Python 侧 candidate != root 的判断）
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new WorkspacePathError(`workspacePath 必须位于 WORKSPACE_ROOT 之下: ${root}`)
  }
  return candidate
}
