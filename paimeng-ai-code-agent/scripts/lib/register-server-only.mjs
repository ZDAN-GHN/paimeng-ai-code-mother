import { register } from 'node:module';

/**
 * 命令行脚本也要能复用 Next 的服务端模块，但这些模块第一行是 `import 'server-only'`，
 * 它的实现是「不在 Next 打包器里就抛错」。这里把该包名映射成一个空模块，让 tsx 能跑。
 * 只影响本次进程，不改变应用构建行为。
 */
register(new URL('./server-only-hook.mjs', import.meta.url));
