/** 把 `server-only` 解析成一个空模块：见 register-server-only.mjs 的说明。 */
export async function resolve(specifier, context, next) {
  if (specifier === 'server-only') {
    return { url: 'data:text/javascript,export%20default%20undefined', shortCircuit: true };
  }
  return next(specifier, context);
}
