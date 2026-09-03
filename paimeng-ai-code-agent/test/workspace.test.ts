import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildTestApp, makeToken, makeWorkspaceRoot, type FastifyInstance } from './helpers.js'

describe('工作区沙箱校验（POST /agent/workspace/validate）', () => {
  let app: FastifyInstance
  let root: string
  let token: string

  beforeAll(async () => {
    root = makeWorkspaceRoot()
    app = buildTestApp(root)
    token = await makeToken()
  })

  const validate = (workspacePath: string) =>
    app.inject({
      method: 'POST',
      url: '/agent/workspace/validate',
      headers: { authorization: `Bearer ${token}` },
      payload: { workspacePath },
    })

  it('根下不存在的子路径 → 200（返回规范化路径）', async () => {
    const res = await validate(path.join(root, 'html_9'))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ valid: true, workspacePath: path.join(root, 'html_9') })
  })

  it('根本身 → 200', async () => {
    const res = await validate(root)
    expect(res.statusCode).toBe(200)
    expect(res.json().workspacePath).toBe(root)
  })

  it('子路径含 .. 但未逃逸 → 200', async () => {
    const res = await validate(path.join(root, 'multi_file_1', '..', 'html_2'))
    expect(res.statusCode).toBe(200)
    expect(res.json().workspacePath).toBe(path.join(root, 'html_2'))
  })

  it('.. 逃逸根 → 400', async () => {
    const res = await validate(path.join(root, '..', 'escape'))
    expect(res.statusCode).toBe(400)
  })

  it('外部绝对路径 → 400', async () => {
    const res = await validate(path.join(tmpdir(), `outside-${Date.now()}`))
    expect(res.statusCode).toBe(400)
  })

  it('相对路径 → 400', async () => {
    const res = await validate('html_1')
    expect(res.statusCode).toBe(400)
  })

  it('空字符串 → 400', async () => {
    const res = await validate('')
    expect(res.statusCode).toBe(400)
  })

  it('缺少 workspacePath 字段 → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/agent/workspace/validate',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('符号链接指向根外 → 400', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'paimeng-outside-'))
    mkdirSync(path.join(root, 'inner'), { recursive: true })
    symlinkSync(outside, path.join(root, 'inner', 'link'))
    const res = await validate(path.join(root, 'inner', 'link'))
    expect(res.statusCode).toBe(400)
  })
})
