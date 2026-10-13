import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * E2E spec 的静态护栏（不需要数据库、不需要浏览器）。
 *
 * 每条规则都对应一次真实事故：
 * - 写死平台地址 / 直接读 APP_ORIGIN：隔离运行换了端口后，10 个用例集体 ECONNREFUSED。
 * - `getByRole('option')`：antd 收起的下拉里也有 role=option 节点，点击时报
 *   "element is not stable / not visible" 直到超时。
 * - `getByRole('alert')`：Next 的路由播报节点（#__next-route-announcer__）也是 role=alert，
 *   断言会命中它而不是业务提示。
 */

type Rule = { readonly pattern: RegExp; readonly advice: string };

const rules: readonly Rule[] = [
  {
    pattern: /https?:\/\/(?:localhost|127\.0\.0\.1):300[01]/,
    advice: "不要写死平台/预览地址：从 './support/app-origin' 导入 appOrigin() 与 previewOrigin()",
  },
  {
    pattern: /process\.env\.(?:APP_ORIGIN|PREVIEW_ORIGIN|ADMIN_PARITY_BASE)/,
    advice: "地址只有一个来源：从 './support/app-origin' 导入 appOrigin() 与 previewOrigin()",
  },
  {
    pattern: /getByRole\(\s*['"]option['"]/,
    advice: "antd 下拉项要用可见的下拉容器：page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').getByText('选项文本', { exact: true })",
  },
  {
    pattern: /getByRole\(\s*['"]alert['"]/,
    advice: "Next 的路由播报节点也是 role=alert：收窄到 .ant-alert-error[role=\"alert\"] 或页面内作用域",
  },
];

const root = process.cwd();
const e2eDir = join(root, 'tests', 'e2e');

function specFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...specFiles(path));
    else if (entry.name.endsWith('.spec.ts')) found.push(path);
  }
  return found;
}

if (!existsSync(e2eDir)) {
  console.error(`找不到 ${e2eDir}；请在 refactor-ts-agent/ 目录下运行本检查`);
  process.exitCode = 1;
} else {
  const files = specFiles(e2eDir);
  const violations: string[] = [];
  for (const file of files) {
    if (file.includes(`${join('tests', 'e2e', 'support')}`)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const rule of rules) {
        if (rule.pattern.test(line)) violations.push(`${relative(root, file)}:${index + 1}: ${rule.advice}`);
      }
    });
  }
  if (violations.length > 0) {
    console.error('E2E 写法检查未通过：');
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
  } else {
    console.log(`E2E 写法检查通过（${files.length} 个 spec）`);
  }
}
