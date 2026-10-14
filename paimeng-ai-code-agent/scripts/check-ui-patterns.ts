import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * 管理端 UI 的静态护栏：只挡「生产构建里看不到、但用户在 dev 里一眼看到」的写法。
 *
 * 每条规则都对应一次真实事故（连续踩了三次）：
 * - `{' '}`：antd 的 Form.Item 收到多个子节点后不再注入 value/onChange，开关会变成
 *   「点了界面会动、保存不落库」的死控件（2026-10-12 六个开关全部失效）。
 * - `Space direction`：antd v6 已废弃，dev 控制台报警告（2026-10-13 用户贴截图）。
 * - `Input addonAfter/addonBefore`：antd v6 已废弃，同样只在 dev 报警告（2026-10-13 复核时发现）。
 * - 有 `name` 的 `Form.Item` 直接子节点不是控件而是包装元素（`Space`/`Space.Compact`/`div` 等）：
 *   antd 只把 value/onChange 注入直接子节点，包装元素会把它们丢掉，字段永远收不到值
 *   （2026-10-13 别名「上游模型名」选了模型却写不进数据库，且没有任何告警）。
 *
 * 这三次的共性是生产构建会剥离告警，所以 `npm run test:e2e:isolated` 抓不到。动态兜底是
 * `npm run test:e2e:dev`（在真实开发服务器上断言控制台没有告警）。
 */

type Rule = { readonly pattern: RegExp; readonly advice: string };

const rules: readonly Rule[] = [
  {
    pattern: /\{'\s*'\}/,
    advice: "不要用 {' '} 做间距：antd 的 Form.Item 会因此拿到多个子节点，受控控件不再绑定表单。用 Space 或 CSS gap",
  },
  {
    pattern: /\baddon(?:After|Before)\s*=/,
    advice: 'antd v6 已废弃 Input 的 addonAfter/addonBefore（只在 dev 报警告）：用 Space.Compact 组合输入框与按钮',
  },
];

/** 会吞掉 antd 注入的 value/onChange 的包装元素：Form.Item 的直接子节点必须是控件本身。 */
const wrapperTags = /^<(Space|Space\.Compact|div|span|section|Row|Col|Card)\b/;

/**
 * 返回从 `<` 开始的 JSX 开标签的结束下标；字符串与 `{}` 表达式里的 `>` 不算标签结束。
 * 这样才能处理 `rules={[{ validator: (_, value) => … }]}` 这类含 `>` 的属性。
 */
function tagEnd(text: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote && text[index - 1] !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    else if (char === '>' && depth === 0) return index;
  }
  return -1;
}

/** 校验有 name 的 Form.Item 直接子节点是不是控件：包装元素会静默吞掉 value/onChange。 */
function formItemWiringViolations(file: string, text: string): string[] {
  const violations: string[] = [];
  const opening = /<Form\.Item\b/g;
  for (const match of text.matchAll(opening)) {
    const start = match.index;
    const end = tagEnd(text, start + match[0].length);
    if (end < 0) continue;
    const tag = text.slice(start, end + 1);
    if (!/\bname\s*=/.test(tag)) continue;
    const child = wrapperTags.exec(text.slice(end + 1).trimStart());
    if (!child) continue;
    const line = text.slice(0, start).split('\n').length;
    violations.push(
      `${file}:${line}: 有 name 的 Form.Item 直接子节点是 <${child[1]}>：antd 注入的 value/onChange 会被丢掉，字段收不到值。把控件放在直接子节点，按钮等放到 Form.Item 外面`,
    );
  }
  return violations;
}

const root = process.cwd();
const sourceDir = join(root, 'src');

function tsxFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...tsxFiles(path));
    else if (entry.name.endsWith('.tsx')) found.push(path);
  }
  return found;
}

if (!existsSync(sourceDir)) {
  console.error(`找不到 ${sourceDir}；请在 paimeng-ai-code-agent/ 目录下运行本检查`);
  process.exitCode = 1;
} else {
  const files = tsxFiles(sourceDir);
  const violations: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      for (const rule of rules) {
        if (rule.pattern.test(line)) violations.push(`${relative(root, file)}:${index + 1}: ${rule.advice}`);
      }
      // `<Space` 的属性可能换行写，所以往前看三行；命中后由 npm run test:e2e:dev 兜底其余废弃属性。
      if (/\bdirection\s*=/.test(line) && lines.slice(Math.max(0, index - 3), index + 1).some(near => /<Space\b/.test(near))) {
        violations.push(`${relative(root, file)}:${index + 1}: antd v6 已废弃 Space 的 direction（只在 dev 报警告）：改用 orientation`);
      }
    });
    violations.push(...formItemWiringViolations(relative(root, file), text));
  }
  if (violations.length > 0) {
    console.error('UI 写法检查未通过：');
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
  } else {
    console.log(`UI 写法检查通过（${files.length} 个 tsx）`);
  }
}
