export function testDatabaseUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== 'mysql:') throw new Error('Integration tests require a MySQL URL');
  if (!['/paimeng_ai_code_mother_ts', '/paimeng_ai_code_mother_ts_test'].includes(url.pathname)) throw new Error('Integration tests require the dedicated TS test database');
  for (const key of url.searchParams.keys()) {
    if (key !== 'charset') throw new Error('Integration test database URL only permits the charset query option');
  }
  url.pathname = '/paimeng_ai_code_mother_ts_test';
  return url.href;
}
