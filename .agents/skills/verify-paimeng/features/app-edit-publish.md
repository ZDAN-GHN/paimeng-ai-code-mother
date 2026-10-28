# 应用编辑、部署与下载

## Sub-features

- 对话页「应用详情」→ 弹窗「修改」→ 改「应用名称」→「保存修改」，跳到 `/app/edit/<id>`
- 编辑页标题「编辑应用信息」，可改名称、删除应用；「进入对话」返回聊天页
- 对话页「部署」→ 弹窗「网站部署成功！」→ 出现「访问作品」链接；封面图写入产品库，由预览服务 `/covers/*.png` 提供
- 「下载代码」下载 `<应用Id>.zip`
- 「版本」按钮 → 「版本历史」弹窗：版本列表、变更文件、差异
- 创建者改自己的应用走 `/api/app/update`；管理员改别人的走 `/api/app/admin/update`

## How to get to it (user POV)

生成完成后停在对话页，点「应用详情」改名；或直接打开 `/app/edit/<应用 ID>`；部署与下载都在对话页工具栏。

## Driving it with Playwright

```ts
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { appOrigin } from '../support/app-origin';

const origin = appOrigin();
const account = 'verify_edit_' + randomUUID().slice(0, 8);
const password = 'password123';

test('生成后改名、部署并下载代码', async ({ page, request }) => {
  await page.request.post('/api/user/register', { headers: { origin }, data: { userAccount: account, userPassword: password, checkPassword: password } });
  await page.request.post('/api/user/login', { headers: { origin }, data: { userAccount: account, userPassword: password } });

  const created = await page.request.post('/api/app/add', {
    headers: { origin },
    data: { initPrompt: '验证编辑与部署', codeGenType: 'html' },
  });
  const appId = (await created.json()).data as string;

  await page.goto('/app/chat/' + appId);
  await expect(page.getByText(/文件已生成/)).toBeVisible({ timeout: 60000 });

  const renamed = '改名_' + account.slice(-8);
  await page.getByRole('button', { name: '应用详情', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^修\s*改$/ }).click();
  await page.getByLabel('应用名称', { exact: true }).fill(renamed);
  await page.getByRole('button', { name: '保存修改' }).click();
  await expect(page).toHaveURL(new RegExp('/app/edit/' + appId + '$'));
  await expect(page.getByRole('heading', { name: '编辑应用信息', exact: true })).toBeVisible();
  expect((await (await page.request.get('/api/app/get/vo?id=' + appId)).json()).data.appName).toBe(renamed);

  await page.getByRole('button', { name: '进入对话' }).click();
  await page.getByRole('button', { name: '部署', exact: true }).click();
  await expect(page.getByText('网站部署成功！')).toBeVisible({ timeout: 30000 });
  await page.getByRole('dialog').getByRole('button', { name: /^关\s*闭$/ }).click();
  await expect(page.getByRole('link', { name: '访问作品' })).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载代码', exact: true }).click();
  expect((await downloadPromise).suggestedFilename()).toBe(appId + '.zip');

  await page.screenshot({ path: 'runtime/evidence/app-edit/after-deploy.png', fullPage: true });
});
```

断言点：改名后接口返回的 `appName` 变了（不只界面）；部署弹窗出现且「访问作品」可见；下载文件名是 `<appId>.zip`。

## Gotchas

- 部署包含封面截图与存储，约 30 秒；断言必须给 `{ timeout: 30000 }`。
- 下载是浏览器事件，必须 `const p = page.waitForEvent('download')` 与点击并发，先点后等会丢事件。
- `/app/add` 只创建记录，不触发生成；生成在打开对话页时由 harness 执行。
- 版本面板依赖 Git 版本库；夹具生成的应用通常只有一个初始版本，想测多版本要用仓库现有的 `version-panel.spec.ts` 的 mock 写法。
- 不要用 `ADMIN_PARITY_BASE` 之类的自造变量，隔离运行时地址由 `app-origin.ts` 决定。
