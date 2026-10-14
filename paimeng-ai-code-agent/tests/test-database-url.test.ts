import { describe, expect, it } from 'vitest';
import { testDatabaseUrl } from './test-database-url';
const source = 'mysql://sample:unused@127.0.0.1:3306/paimeng_ai_code_mother_ts';
const target = 'mysql://sample:unused@127.0.0.1:3306/paimeng_ai_code_mother_ts_test';
describe('集成测试数据库选择边界', () => {
  it('将专用开发库 URL 转换为测试库，重复执行保持同一目标', () => {
    expect(testDatabaseUrl(source)).toBe(target);
    expect(testDatabaseUrl(target)).toBe(target);
  });
  it('带字符集查询参数时仍只指向测试库并保留参数', () => {
    expect(testDatabaseUrl(source + '?charset=utf8mb4')).toBe(target + '?charset=utf8mb4');
    expect(testDatabaseUrl(target + '?charset=utf8mb4')).toBe(target + '?charset=utf8mb4');
  });
  it('拒绝旧库、未知库、非 MySQL URL 和无效 URL', () => {
    for (const raw of [source.replace('mother_ts', 'mother'), source.replace('mother_ts', 'another_database'), source.replace('mysql:', 'https:'), '']) expect(() => testDatabaseUrl(raw)).toThrow();
  });
  it('拒绝可能覆盖连接目标的 mysql2 查询选项', () => {
    for (const query of ['database=paimeng_ai_code_mother_ts', 'host=external.invalid', 'port=3306', 'socketPath=%2Ftmp%2Fmysql.sock', 'uri=mysql%3A%2F%2Fexternal.invalid', 'charset=utf8mb4&database=paimeng_ai_code_mother_ts']) expect(() => testDatabaseUrl(source + '?' + query)).toThrow('query option');
  });
});
