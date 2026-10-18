export function testDatabaseUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== 'postgres:') throw new Error('Integration tests require a Postgres URL');
  if (!['/paimeng_app', '/paimeng_app_test'].includes(url.pathname)) throw new Error('Integration tests require the dedicated app test database');
  for (const key of url.searchParams.keys()) throw new Error(`Integration test database URL does not permit query options (${key})`);
  url.pathname = '/paimeng_app_test';
  return url.href;
}

/** The pi-durable storage database beside the product test database; the harness creates its own tables there. */
export function storageTestDatabaseUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== 'postgres:') throw new Error('The harness storage requires a Postgres URL');
  if (!['/paimeng_agent', '/paimeng_agent_test'].includes(url.pathname)) throw new Error('The harness storage must use the dedicated storage database');
  for (const key of url.searchParams.keys()) throw new Error(`Harness storage URL does not permit query options (${key})`);
  url.pathname = '/paimeng_agent_test';
  return url.href;
}
