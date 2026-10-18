export function testDatabaseUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== 'postgres:') throw new Error('Integration tests require a Postgres URL');
  if (!['/paimeng_ts', '/paimeng_ts_test'].includes(url.pathname)) throw new Error('Integration tests require the dedicated TS test database');
  for (const key of url.searchParams.keys()) throw new Error(`Integration test database URL does not permit query options (${key})`);
  url.pathname = '/paimeng_ts_test';
  return url.href;
}
