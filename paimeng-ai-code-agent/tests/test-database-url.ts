export function testDatabaseUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== 'postgres:') throw new Error('Integration tests require a Postgres URL');
  if (!['/paimeng_app', '/paimeng_app_test'].includes(url.pathname)) throw new Error('Integration tests require the dedicated app test database');
  for (const key of url.searchParams.keys()) throw new Error(`Integration test database URL does not permit query options (${key})`);
  url.pathname = '/paimeng_app_test';
  return url.href;
}
