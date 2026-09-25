/**
 * POSIX shell 单参数转义（Issue #77 / T-05）。
 *
 * 存在理由：Sandbox 的文件操作经 Java `/commands` 端点合成，而该端点以
 * `sh -c <command>` 执行。命令里的路径与内容**来自模型的工具调用入参**，
 * 即不可信输入。没有这层转义，一个形如 `a'; rm -rf /workspace; '` 的路径
 * 就会逃出参数位变成第二条命令。
 *
 * 因此本模块是隔离边界内的注入防线，不是排版工具。
 */

export class ShellQuoteError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'ShellQuoteError'
  }
}

/**
 * 把任意字符串转义为单个 shell 参数。
 *
 * 做法：整体包单引号，并把内部每个单引号替换为 `'\''`（闭合、转义引号、重开）。
 * 单引号内 shell 不做任何展开——变量、命令替换、通配符、反斜杠全部失效——
 * 所以只需处理单引号本身这一个逃逸字符。
 *
 * 例：`don't` → `'don'\''t'`，shell 解析回 `don't`。
 */
export function quoteShellArgument(value: string): string {
  if (value.includes('\0')) {
    // NUL 无法穿过 argv：C 字符串在此截断，转义后的命令会与预期不同。
    // 静默截断比报错危险得多——那会让"写入 a\0b"变成"写入 a"。
    throw new ShellQuoteError('Shell arguments must not contain NUL bytes')
  }

  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * 容器内的绝对路径校验。
 *
 * 转义解决"逃出参数位"，但解决不了"参数本身指向不该碰的地方"：
 * `/etc/passwd` 是完全合法的 shell 参数。可写区判定由 `ExecutionCapabilities`
 * 负责（Platform 下发的事实），这里只挡明显非法的形状。
 */
export function assertAbsoluteContainerPath(candidatePath: string): void {
  if (!candidatePath.startsWith('/')) {
    throw new ShellQuoteError(`Expected an absolute container path: ${candidatePath}`)
  }
  if (candidatePath.includes('\0')) {
    throw new ShellQuoteError('Container paths must not contain NUL bytes')
  }
}
