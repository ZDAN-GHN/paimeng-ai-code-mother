// 线框生成（Issue #7）：单文件 HTML（灰块 + 占位图 + 可点击页面跳转 + 站点地图），MVP 页面数上限 5 页，
// 快速档模型输出（架构 §4）。脚本化实现确定性生成线框 HTML——「访谈结论 → 线框」即快速档模型的契约；
// 接入真实快速档模型时替换 buildWireframeHtml 内部实现，输入输出与验收断言不变。
// 线框文件存 {workspace}/wireframe/（跨请求存活，未确认前可重生成），确认后即 codegen 布局契约与视觉 diff 基准。
import type { InterviewSummary } from './interview.js'

// 线框文件名（存 {workspace}/wireframe/ 子目录下）
export const WIREFRAME_FILENAME = 'wireframe.html'

// MVP 线框页面数上限（架构 §4：MVP 页面数上限 5 页）
export const PAGE_LIMIT = 5

// 单个页面的灰块布局（导航/主视觉/内容网格/页脚 + 图片占位）
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

// 转义 HTML 特殊字符（页面名来自用户输入，落盘前转义防注入）
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
    return map[ch]!
  })
}

// 由访谈结论生成单文件线框 HTML：
// - 站点地图：页面清单 + 导航关系（锚点可点击跳转）
// - 每页灰块布局 + 占位图（可点击页面跳转经页内锚点实现，单文件无需多页路由）
// - 页面数 ≤ 5（取访谈结论的页面清单并截断到上限）
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

// 统计线框 HTML 中的页面数（验收断言：≤5 页）
export function countWireframePages(html: string): number {
  const matches = html.match(/<section class="page"/g)
  return matches?.length ?? 0
}
