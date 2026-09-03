import path from 'node:path'
import { SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import { makeToken, makeWorkspaceRoot, buildTestApp, TEST_SECRET } from './helpers.js'

// 受保护路由取 workspace/validate：合法令牌可以拿到 200，恰好同时验证鉴权放行
const PROTECTED_URL = '/agent/workspace/validate'

describe('/agent/* JWT 鉴权', () => {
  it('无 Authorization → 401', async () => {
    const app = buildTestApp()
    const res = await app.inject({ method: 'POST', url: PROTECTED_URL, payload: { workspacePath: '/tmp/x' } })
    expect(res.statusCode).toBe(401)
  })

  it('非 Bearer 格式 → 401', async () => {
    const app = buildTestApp()
    const res = await app.inject({
      method: 'POST',
      url: PROTECTED_URL,
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
      payload: { workspacePath: '/tmp/x' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('乱串令牌 → 401', async () => {
    const app = buildTestApp()
    const res = await app.inject({
      method: 'POST',
      url: PROTECTED_URL,
      headers: { authorization: 'Bearer not-a-jwt' },
      payload: { workspacePath: '/tmp/x' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('错误密钥签名 → 401', async () => {
    const app = buildTestApp()
    const token = await new SignJWT({ appId: 1 })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('42')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('another-secret'))
    const res = await app.inject({
      method: 'POST',
      url: PROTECTED_URL,
      headers: { authorization: `Bearer ${token}` },
      payload: { workspacePath: '/tmp/x' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('过期令牌 → 401', async () => {
    const app = buildTestApp()
    const token = await makeToken({ expiresIn: Math.floor(Date.now() / 1000) - 60 })
    const res = await app.inject({
      method: 'POST',
      url: PROTECTED_URL,
      headers: { authorization: `Bearer ${token}` },
      payload: { workspacePath: '/tmp/x' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('非白名单算法（HS512）→ 401', async () => {
    const app = buildTestApp()
    const token = await new SignJWT({ appId: 1 })
      .setProtectedHeader({ alg: 'HS512' })
      .setSubject('42')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(TEST_SECRET))
    const res = await app.inject({
      method: 'POST',
      url: PROTECTED_URL,
      headers: { authorization: `Bearer ${token}` },
      payload: { workspacePath: '/tmp/x' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('缺少 sub 声明 → 401', async () => {
    const app = buildTestApp()
    const token = await new SignJWT({ appId: 1 })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(TEST_SECRET))
    const res = await app.inject({
      method: 'POST',
      url: PROTECTED_URL,
      headers: { authorization: `Bearer ${token}` },
      payload: { workspacePath: '/tmp/x' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('合法令牌 → 200 且 sub 可读', async () => {
    const root = makeWorkspaceRoot()
    const app = buildTestApp(root)
    const token = await makeToken()
    const res = await app.inject({
      method: 'POST',
      url: PROTECTED_URL,
      headers: { authorization: `Bearer ${token}` },
      payload: { workspacePath: path.join(root, 'html_1') },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ valid: true, workspacePath: path.join(root, 'html_1') })
  })
})
