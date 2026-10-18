import { describe, expect, it } from 'vitest';
import { testDatabaseUrl } from './test-database-url';
const source = 'postgres://spike:spike@127.0.0.1:55432/paimeng_ts';
const target = 'postgres://spike:spike@127.0.0.1:55432/paimeng_ts_test';
describe('集成测试数据库选择边界', () => {
  it('将专用开发库 URL 转换为测试库，重复执行保持同一目标', () => {
    expect(testDatabaseUrl(source)).toBe(target);
    expect(testDatabaseUrl(target)).toBe(target);
  });
  it('拒绝旧库、未知库、非 Postgres URL 和无效 URL', () => {
    for (const raw of [source.replace('paimeng_ts', 'paimeng'), source.replace('paimeng_ts', 'another_database'), source.replace('postgres:', 'mysql:'), source.replace('postgres:', 'https:'), '']) expect(() => testDatabaseUrl(raw)).toThrow();
  });
  it('拒绝可能覆盖连接目标的查询选项', () => {
    for (const query of ['database=postgres', 'host=external.invalid', 'port=5432', 'options=-c%20search_path%3Dpublic']) expect(() => testDatabaseUrl(source + '?' + query)).toThrow('query option');
  });
});
