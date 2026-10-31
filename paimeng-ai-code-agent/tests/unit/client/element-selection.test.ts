import { describe, expect, it } from 'vitest';
import { maxSelectedElements, selectedElementsSchema, selectionContext, type SelectedElement } from '@/shared/element-selection';

const element = (overrides: Partial<SelectedElement> = {}): SelectedElement => ({
  selector: 'body>h1#hero', tagName: 'H1', id: 'hero', className: 'title main',
  textContent: '预览标题', pagePath: '/preview/html_900001/', ...overrides,
});

describe('选中元素的定位上下文', () => {
  it('没有选中元素时不产生任何上下文', () => {
    expect(selectionContext([])).toBe('');
  });

  it('单个元素给出页面路径、标签、选择器、ID、class 与内容', () => {
    const context = selectionContext([element()]);
    expect(context).toContain('选中元素信息（1 个）：');
    expect(context).toContain('- 页面路径: /preview/html_900001/');
    expect(context).toContain('- 元素 1');
    expect(context).toContain('  - 标签: h1');
    expect(context).toContain('  - 选择器: body>h1#hero');
    expect(context).toContain('  - ID: hero');
    expect(context).toContain('  - class: title main');
    expect(context).toContain('  - 当前内容: 预览标题');
  });

  it('同一页面的多个元素按顺序编号，页面路径只写一次', () => {
    const context = selectionContext([
      element(),
      element({ selector: 'body>nav#nav', tagName: 'NAV', id: 'nav', className: 'menu', textContent: '首页 关于' }),
    ]);
    expect(context).toContain('选中元素信息（2 个）：');
    expect(context.match(/页面路径: \/preview\/html_900001\//g)).toHaveLength(1);
    expect(context).toContain('- 元素 1');
    expect(context).toContain('- 元素 2');
    expect(context).toContain('  - 选择器: body>h1#hero');
    expect(context).toContain('  - 选择器: body>nav#nav');
    expect(context.indexOf('body>h1#hero')).toBeLessThan(context.indexOf('body>nav#nav'));
  });

  it('不同页面的元素各自带上自己的页面路径', () => {
    const context = selectionContext([element(), element({ selector: 'body>p', id: '', className: '', pagePath: '/preview/html_900001/about' })]);
    expect(context).toContain('- 页面路径: /preview/html_900001/');
    expect(context).toContain('  - 页面路径: /preview/html_900001/about');
  });

  it('内容截断到 100 字，不把整段文字带进输入上限', () => {
    const context = selectionContext([element({ textContent: '长'.repeat(150) })]);
    expect(context).toContain('  - 当前内容: ' + '长'.repeat(100));
    expect(context).not.toContain('长'.repeat(101));
  });
});

describe('选中元素的上报形状', () => {
  it('接受合法快照，拒绝空选择器与超出上限的数量', () => {
    expect(selectedElementsSchema.safeParse([element()]).success).toBe(true);
    expect(selectedElementsSchema.safeParse([element({ selector: '' })]).success).toBe(false);
    const tooMany = Array.from({ length: maxSelectedElements + 1 }, (_, index) => element({ selector: 'body>p:nth-of-type(' + (index + 1) + ')' }));
    expect(selectedElementsSchema.safeParse(tooMany).success).toBe(false);
  });
});
