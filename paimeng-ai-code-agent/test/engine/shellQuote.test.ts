import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  assertAbsoluteContainerPath,
  quoteShellArgument,
  ShellQuoteError,
} from '../../src/engine/shellQuote.js'

const execFileAsync = promisify(execFile)

/**
 * 用真实 `sh -c` 做往返验证。
 *
 * 单纯断言转义后的字符串长什么样，只能证明"我的实现符合我的预期"；
 * 真正要证的是"shell 解析回原值"。Java 侧执行的正是 `sh -c`，所以这里的
 * 被测对象必须是同一个解析器，而不是我对 POSIX 引用规则的记忆。
 */
async function roundTripThroughShell(value: string): Promise<string> {
  // printf '%s' 不加尾换行、不解释转义，是最无副作用的回显方式
  const { stdout } = await execFileAsync('sh', ['-c', `printf '%s' ${quoteShellArgument(value)}`])
  return stdout
}

test('round-trips shell metacharacters through a real sh -c', async () => {
  const hostileValues = [
    'plain.txt',
    '/workspace/src/App.vue',
    "it's here",
    'a b\tc',
    '$HOME',
    '${PATH}',
    '`whoami`',
    '$(whoami)',
    'a;b',
    'a|b',
    'a&b',
    'a>b<c',
    'a*b?c[d]',
    'back\\slash',
    'double"quote',
    'new\nline',
    '#comment',
    '~root',
    '!history',
    '',
    '中文路径.ts',
    "'",
    "''",
    "'\"'",
  ]

  for (const value of hostileValues) {
    assert.equal(await roundTripThroughShell(value), value, `failed to round-trip: ${value}`)
  }
})

/**
 * 注入面的核心用例：让转义失效就能执行第二条命令。
 *
 * 这个路径形如模型可能产出的文件名。若转义有缺陷，`touch` 会真的建出文件，
 * 于是回显内容与原值不同——断言相等即证明它始终停留在参数位。
 */
test('keeps injection payloads inside the argument position', async () => {
  const injectionAttempts = [
    "x'; echo INJECTED; '",
    "x' && echo INJECTED && '",
    '$(echo INJECTED)',
    '`echo INJECTED`',
    "'; rm -rf /nonexistent; echo INJECTED; '",
  ]

  for (const attempt of injectionAttempts) {
    const observed = await roundTripThroughShell(attempt)
    assert.equal(observed, attempt)
    assert.ok(!observed.includes('INJECTED\n'), `payload executed: ${attempt}`)
  }
})

/**
 * NUL 必须报错而非静默截断。
 *
 * argv 是 C 字符串：`a\0b` 传进去只剩 `a`。若放行，"写入 a\0b" 会静默变成
 * "写入 a"——一个内容被悄悄改写的成功返回，比一个失败危险得多。
 */
test('rejects NUL bytes instead of silently truncating the argument', () => {
  assert.throws(() => quoteShellArgument('a\0b'), ShellQuoteError)
  assert.throws(() => assertAbsoluteContainerPath('/workspace/a\0b'), ShellQuoteError)
})

test('rejects relative container paths', () => {
  assert.throws(() => assertAbsoluteContainerPath('workspace/App.vue'), ShellQuoteError)
  assert.throws(() => assertAbsoluteContainerPath('./App.vue'), ShellQuoteError)
  assert.throws(() => assertAbsoluteContainerPath('../escape'), ShellQuoteError)
  assert.doesNotThrow(() => assertAbsoluteContainerPath('/workspace/App.vue'))
})
