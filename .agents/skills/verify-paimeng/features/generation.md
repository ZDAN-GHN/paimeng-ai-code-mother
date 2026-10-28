# 首页创建应用并生成

## Sub-features

- 首页 `/`：技术栈下拉（16 个分类模板，虚拟滚动）、应用描述输入、「创建应用」
- 创建后跳到对话页 `/app/chat/<雪花 ID>`，流式展示 AI 气泡与工具调用（`.message-ai .tool-call`）
- 生成完成：出现「文件已生成」「可预览」
- 预览 `iframe[title="应用预览"]`，加载自预览服务（另一个 origin，默认 `127.0.0.1:3001`，隔离时是 `127.0.0.1:3021`）
- 「可视化编辑」进入元素选择，「退出编辑」退出
- 「本次生成用量」折叠面板：轮次、模型绑定

## How to get to it (user POV)

登录后停在首页 `/`，点「技术栈」选一个模板，在「应用描述」里写需求，点「创建应用」，等对话页出现「文件已生成」。

## Driving it with Playwright

```ts
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { appOrigin } from '../support/app-origin';
import { pickStack } from '../support/stack-select';

const origin = appOrigin();
const account = 'verify_gen_' + randomUUID().slice(0, 8);
const describe = '验证生成_' + account.slice(-8);

test('创建应用后生成出可预览的页面', async ({ page }) => {
  await page.request.post('/api/user/register', {
    headers: { origin },
    data: { userAccount: account, userPassword: 'password123', checkPassword: 'password123' },
  });
  await page.goto('/user/login');
  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill('password123');
  await page.locator('form').getByRole('button', { name: /^登\s*录$/ }).click();

  await page.getByLabel('技术栈', { exact: true }).click();
  await pickStack(page, 'html/one-page · 单文件静态页');
  await page.getByLabel('应用描述').fill(describe);
  await page.getByRole('button', { name: '创建应用', exact: true }).click();

  await expect(page).toHaveURL(/\/app\/chat\/\d+/);
  await expect(page.getByText(/文件已生成/)).toBeVisible({ timeout: 60000 });
  await expect(page.getByText('可预览', { exact: true })).toBeVisible();

  const preview = page.frameLocator('iframe[title="应用预览"]');
  await expect(preview.getByRole('heading', { name: describe })).toBeVisible();
  await page.screenshot({ path: 'runtime/evidence/generation/chat-preview.png', fullPage: true });
});
```

断言点：URL 含 `/app/chat/<数字 ID>`；「文件已生成」「可预览」可见；预览 iframe 内有描述文字对应的标题。

## Gotchas

- 技术栈下拉是虚拟滚动，没滚到的选项根本不在 DOM 里。必须用 `support/stack-select.ts` 的 `pickStack`，直接 `getByText` 会一直等。
- 隔离运行用夹具（`DURABLE_FAUX_FIXTURE=1`），生成固定文案「文件已生成，正在验证与构建。此回复来自可控测试模型。」；真模型下措辞和耗时都不同，不要断言这段原文，除非确认在夹具下跑。
- 预览是另一个 origin，只能通过 `page.frameLocator` 访问；在主页面里找预览元素会超时。
- `html/one-page` 最快；`react_project`、`vue_project` 会用 Docker 构建，现有用例把超时提到 180s，且需要先 `docker pull node:24-alpine`。
- 生成要经过 harness（默认端口 5599，隔离时自选空闲端口）。harness 没起来时页面会一直转圈，先跑 `doctor.sh`。
