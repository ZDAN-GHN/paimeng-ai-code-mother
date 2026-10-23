import { describe, expect, it } from 'vitest';
import { agentVersionTitle, fallbackVersionTitle, normalizeVersionSummary, versionSummaryLimit } from '@/server/version-summary';
import type { AppVersion } from '@/shared/versioning';

const base: AppVersion = {
  id: '0'.repeat(40), title: '', createTime: '2026-10-20 10:00:00',
  changedFiles: ['index.html', 'assets/a.jpg'],
  fileCount: 6, bytes: 1, thumbnailKey: null, statsKnown: true,
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

  it('助手原话当兜底标题：去掉代码标记与客套开场，只留第一句', () => {
    // 真实出现过的收尾原话：整段是解释，标题只需要前半句。
    expect(agentVersionTitle('已完成一个完整的创作者作品集网站，全部写在 `index.html` 中（样式在 `<style>` 里）'))
      .toBe('一个完整的创作者作品集网站');
    expect(agentVersionTitle('好的，我把首页改成了分栏大图。其余保持原样。')).toBe('把首页改成了分栏大图');
    expect(agentVersionTitle('```html\n<h1>x</h1>\n```\n页面加了一个大标题')).toBe('页面加了一个大标题');
    // 空话等于没说：交给文件级兜底。
    expect(agentVersionTitle('已完成')).toBe(null);
    expect(agentVersionTitle('好的。')).toBe(null);
    expect(agentVersionTitle('')).toBe(null);
  });

  it('兜底标题直接说改了哪个文件，不照抄用户原话', () => {
    expect(fallbackVersionTitle(base)).toBe('改 index.html 等 2 个文件');
    expect(fallbackVersionTitle({ ...base, changedFiles: ['index.html'] })).toBe('改 index.html');
    // 合并提交相对第一个父提交可能没有文件差异，用「合并」而不是假装第几版。
    expect(fallbackVersionTitle({ ...base, changedFiles: [] })).toBe('合并已有版本');
    for (const changedFiles of [['a'], ['a', 'b'], [], ['a/very/long/directory/name/index.html', 'b.css']]) {
      const title = fallbackVersionTitle({ ...base, changedFiles });
      expect([...title].length).toBeLessThanOrEqual(versionSummaryLimit);
    }
  });
});
