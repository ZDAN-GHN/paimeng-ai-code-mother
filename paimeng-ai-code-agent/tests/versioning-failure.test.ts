import { describe, expect, it } from 'vitest';
import { versionFailureHint } from '@/shared/versioning';

describe('版本读取失败的提示', () => {
  it('把「版本表不存在」翻成可以直接照做的迁移提示', () => {
    expect(versionFailureHint('relation "app_version_state" does not exist')).toContain('npm run db:migrate');
    expect(versionFailureHint('SQLITE_ERROR: no such table: app_version')).toContain('npm run db:migrate');
  });

  it('其它错误不翻译，交给上层按原样处理', () => {
    expect(versionFailureHint('connect ECONNREFUSED 127.0.0.1:5432')).toBeNull();
    expect(versionFailureHint('relation "app_user" does not exist')).toBeNull();
    expect(versionFailureHint('')).toBeNull();
  });
});
