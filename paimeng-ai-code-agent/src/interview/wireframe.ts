



import type { InterviewSummary } from './index.js'


export const WIREFRAME_FILENAME = 'wireframe.html'


export const PAGE_LIMIT = 5


function pageSection(page: string, index: number): string {
  return [
    `<section class="page" id="page-${index}">`,
    `  <h2>页面 ${index + 1}：${escapeHtml(page)}</h2>`,
    `  <div class="block">顶部导航栏（logo + 菜单占位）</div>`,
    `  <div class="block ph">主视觉 Banner 图片占位</div>`,
    `  <div class="grid">`,
    `    <div class="block ph">内容卡片图片占位</div>`,
    `    <div class="block ph">内容卡片图片占位</div>`,
    `    <div class="block ph">内容卡片图片占位</div>`,
    `  </div>`,
    `  <div class="block">页脚占位</div>`,
    `</section>`,
  ].join('\n')
}


function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
    return map[ch]!
  })
}





export function buildWireframeHtml(summary: InterviewSummary): string {
  const pages = summary.pages.slice(0, PAGE_LIMIT)
  const siteTitle = summary.message || '我的网站'
  const sitemapItems = pages.map((page, index) => `    <li><a href="#page-${index}">${escapeHtml(page)}</a></li>`).join('\n')
  const sections = pages.map((page, index) => pageSection(page, index)).join('\n')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(siteTitle)} - 线框预览</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; color: #333; background: #fff; }
  .wf { max-width: 960px; margin: 0 auto; padding: 0 16px; }
  header.site { background: #eee; border: 1px dashed #bbb; padding: 12px 16px; }
  nav.sitemap { background: #f5f5f5; border: 1px dashed #ccc; margin: 16px 0; padding: 12px 16px; }
  nav.sitemap h2 { margin: 0 0 8px; font-size: 14px; color: #666; }
  nav.sitemap ul { margin: 0; padding-left: 20px; }
  nav.sitemap li { margin: 4px 0; }
  section.page { border: 1px solid #ddd; margin: 24px 0; padding: 16px; background: #fafafa; }
  section.page h2 { margin: 0 0 12px; font-size: 18px; }
  .block { background: #e8e8e8; border: 1px dashed #bbb; padding: 10px; text-align: center; color: #888; margin: 8px 0; font-size: 13px; }
  .ph { height: 120px; display: flex; align-items: center; justify-content: center; }
  .grid { display: flex; gap: 12px; }
  .grid > div { flex: 1; }
  footer { margin: 24px 0; padding: 12px; text-align: center; color: #999; font-size: 12px; }
  @media (max-width: 600px) { .grid { flex-direction: column; } }
</style>
</head>
<body>
<header class="site wf"><strong>${escapeHtml(siteTitle)}</strong> — 线框预览</header>
<div class="wf">
  <nav class="sitemap">
    <h2>站点地图（${pages.length} 页）</h2>
    <ul>
${sitemapItems}
    </ul>
  </nav>
${sections}
  <footer>线框由 AI 生成，仅供布局确认，不扣除积分</footer>
</div>
</body>
</html>
`
}


export function countWireframePages(html: string): number {
  const matches = html.match(/<section class="page"/g)
  return matches?.length ?? 0
}
