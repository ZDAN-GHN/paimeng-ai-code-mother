import path from 'node:path'
import { fileURLToPath } from 'node:url'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const defaultRoot =
  path.basename(moduleDir) === 'dist'
    ? path.resolve(moduleDir, '..')
    : path.resolve(moduleDir, '../..')

export const agentRoot = process.env.AGENT_ROOT ? path.resolve(process.env.AGENT_ROOT) : defaultRoot
