import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'

const phase = process.argv[2]
const base = process.env.APP_BASE_PATH
const cwd = '/workspace/app'
const bin = (name) => `/opt/validation/node_modules/.bin/${name}`
let stage = 'OTHER'
function run(command, args, seconds = 90) {
  const result = spawnSync(command, args, { cwd, stdio: 'ignore', timeout: seconds * 1000,
    env: { ...process.env, npm_config_offline: 'true', npm_config_ignore_scripts: 'true' } })
  if (result.error || result.status !== 0) throw Error('CHECK_FAILED')
}
async function request(path, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:3000${path}`, {
    method, redirect: 'manual', signal: AbortSignal.timeout(3000),
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (response.status >= 300 && response.status < 400) throw Error('REDIRECT_REJECTED')
  const length = Number(response.headers.get('content-length') ?? '0')
  if (length > 65536) throw Error('RESPONSE_LIMIT')
  const reader = response.body.getReader()
  let size = 0
  const chunks = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 65536) throw Error('RESPONSE_LIMIT')
      chunks.push(value)
    }
  } finally { await reader.cancel() }
  const bytes = Buffer.concat(chunks)
  return { status: response.status, text: bytes.toString('utf8') }
}
function equals(a, b) { return JSON.stringify(a) === JSON.stringify(b) }
function at(node, pointer) {
  if (pointer === '') return node
  return pointer.slice(1).split('/').reduce((value, key) => {
    const segment = key.replace(/~1/g, '/').replace(/~0/g, '~')
    return value !== null && typeof value === 'object' && Object.hasOwn(value, segment)
      ? value[segment] : undefined
  }, node)
}
try {
  if (phase === 'engineering') {
    run(bin('prisma'), ['generate'])
    run(bin('tsc'), ['-p', 'tsconfig.server.json', '--noEmit'])
    run(bin('tsc'), ['-p', 'tsconfig.test.json'])
    run(bin('vue-tsc'), ['-p', 'tsconfig.web.json', '--noEmit'])
    run(bin('tsc'), ['-p', 'tsconfig.server.json'])
    run(bin('vite'), ['build'], 120)
    const tests = readdirSync(`${cwd}/test`).filter(name => /^[A-Za-z0-9_-]+\.test\.ts$/.test(name))
    if (!tests.length || tests.length > 64) throw Error('CHECK_FAILED')
    run('/usr/local/bin/node', ['--experimental-strip-types', '--test', ...tests.map(name => `test/${name}`)], 90)
  } else if (phase === 'database') {
    run(bin('prisma'), ['migrate', 'deploy'], 90)
    run(bin('prisma'), ['migrate', 'status'], 30)
  } else if (phase === 'runtime' || phase === 'acceptance') {
    stage = 'HEALTH'
    let ready = false
    for (let i = 0; i < 25; i++) {
      try { if ((await request('/healthz')).status === 200) { ready = true; break } } catch {}
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    if (!ready) throw Error('HEALTH_FAILED')
    if (phase === 'runtime') {
      stage = 'SUBPATH'
      const page = await request(base)
      if (page.status !== 200 || !page.text.includes(`${base}assets/`)) throw Error('SUBPATH_FAILED')
      stage = 'API'
      const api = await request(`${base}api/items`)
      if (api.status !== 200 || !Array.isArray(JSON.parse(api.text))) throw Error('API_FAILED')
    } else {
      stage = 'ACCEPTANCE'
      const checks = JSON.parse(process.env.VALIDATION_CHECKS).checks
      for (const check of checks) {
        const response = await request(`${base.slice(0, -1)}${check.path}`, check.method, check.requestBody)
        if (response.status !== check.expectedStatus) throw Error('ASSERTION_FAILED')
        if (check.expectedBody !== undefined) {
          let decoded
          try { decoded = JSON.parse(response.text) } catch { throw Error('ASSERTION_FAILED') }
          if (!equals(at(decoded, check.expectedBody.pointer), check.expectedBody.equals)) throw Error('ASSERTION_FAILED')
        }
      }
    }
  } else throw Error('UNKNOWN_PHASE')
  process.exit(0)
} catch {
  // Never emit candidate source, HTTP bodies, database URLs or credentials to the caller.
  process.exit({ HEALTH: 21, SUBPATH: 22, API: 23, ACCEPTANCE: 24 }[stage] ?? 1)
}
