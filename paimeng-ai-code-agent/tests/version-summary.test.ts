import { describe, expect, it } from 'vitest';
import { fallbackVersionTitle, normalizeVersionSummary, versionSummaryLimit } from '@/server/version-summary';
import type { AppVersion } from '@/shared/versioning';

const base: AppVersion = {
  id: 'v', appId: '1', branch: 'main', seq: 3, commitSha: 'a', kind: 'generate', sourceVersionId: null,
  title: '', prompt: '把页面改得更加酷炫一点，现在的ai味太浓了', changedFiles: ['index.html', 'assets/a.jpg'],
  fileCount: 6, bytes: 1, thumbnailKey: null, generationId: null, createTime: '2026-10-20 10:00:00', superseded: false,
};

describe('版本概述', () => {
  it('擦掉模型带回来的引号、句号和「用户想要」这类前缀', () => {
    expect(normalizeVersionSummary('「加了深色模式。」')).toBe('加了深色模式');
    expect(normalizeVersionSummary('用户想要: 重做首页排版')).toBe('重做首页排版');
    expect(normalizeVersionSummary('  多行\n文本  ')).toBe('多行 文本');
  });

  it('超过 20 个字就截断，不截半个字符', () => {
    const long = '把首页的排版彻底重做成杂志风格并且加上深色模式切换和动画';
    const result = normalizeVersionSummary(long);
    expect([...result].length).toBeLessThanOrEqual(versionSummaryLimit);
    expect(result).toBe([...long].slice(0, versionSummaryLimit).join(''));
  });

  it('兜底标题用改动数量，不照抄用户原话', () => {
    expect(fallbackVersionTitle(base)).toBe('改动 2 个文件');
    expect(fallbackVersionTitle({ ...base, changedFiles: ['index.html'] })).toBe('改动 1 个文件');
    expect(fallbackVersionTitle({ ...base, changedFiles: [], seq: 7 })).toBe('第 7 版');
    expect(fallbackVersionTitle({ ...base, kind: 'checkpoint' })).toBe('切版前的快照');
    expect(fallbackVersionTitle({ ...base, kind: 'restore' })).toBe('回到历史版本');
    for (const kind of ['generate', 'checkpoint', 'restore', 'branch', 'adopt'] as const) {
      const title = fallbackVersionTitle({ ...base, kind });
      expect([...title].length).toBeLessThanOrEqual(versionSummaryLimit);
      expect(title).not.toBe(base.prompt);
    }
  });
});
