# 个人中心：长期记忆

## Sub-features

- `/user/me`：个人资料与「长期记忆」列表；空态文案「还没有长期记忆，聊天时让我记住你的偏好试试」
- 记忆由 agent 工具在对话中写入；页面上可编辑（「编辑记忆」→「记忆内容」→「保存」）与删除（「删除记忆」→ 确认「删除」）
- 记忆按账号隔离，换账号看不到别人的

## How to get to it (user POV)

登录后点右上角用户菜单 →「个人中心」，或直接打开 `/user/me`。

## Driving it with Playwright

```ts
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadEnvFile } from 'node:process';
import { appOrigin } from '../support/app-origin';
import { testDatabaseUrl } from '../../test-database-url';

loadEnvFile('.env');
const origin = appOrigin();
const password = 'password123';
const account = 'verify_memory_' + randomUUID().slice(0, 8);

test('个人中心能编辑和删除长期记忆', async ({ page }) => {
  await page.request.post('/api/user/register', { headers: { origin }, data: { userAccount: account, userPassword: password, checkPassword: password } });
  await page.request.post('/api/user/login', { headers: { origin }, data: { userAccount: account, userPassword: password } });

  const client = new pg.Client({ connectionString: new URL(testDatabaseUrl(process.env.DATABASE_URL!)).href });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>('SELECT id FROM app_user WHERE user_account = $1', [account]);
    for (const content of ['偏好深色主题', '在做一个宠物商店']) {
      await client.query(
        "INSERT INTO user_memory (user_id, content, create_time, update_time) VALUES ($1, $2, timezone('UTC', now()), timezone('UTC', now()))",
        [rows[0]!.id, content],
      );
    }
  } finally {
    await client.end();
  }

  await page.goto('/user/me');
  await expect(page.getByRole('heading', { name: '个人中心' })).toBeVisible();
  await expect(page.getByText('偏好深色主题')).toBeVisible();

  await page.getByRole('listitem').filter({ hasText: '偏好深色主题' }).getByRole('button', { name: '编辑记忆' }).click();
  const editing = page.getByRole('listitem').filter({ has: page.getByLabel('记忆内容') });
  await editing.getByLabel('记忆内容').fill('偏好浅色主题');
  await editing.getByRole('button', { name: /^保\s*存$/ }).click();
  await expect(page.getByText('偏好浅色主题')).toBeVisible();

  await page.getByRole('listitem').filter({ hasText: '在做一个宠物商店' }).getByRole('button', { name: '删除记忆' }).click();
  await page.getByRole('button', { name: /^删\s*除$/ }).click();
  await expect(page.getByText('在做一个宠物商店')).toHaveCount(0);

  await page.screenshot({ path: 'runtime/evidence/user-memory/after-edit.png', fullPage: true });
});
```

断言点：编辑后新文案可见、旧文案消失；删除后该条 `toHaveCount(0)`；刷新页面后结果保持（证明落库，不是本地状态）。

## Gotchas

- 直接插 `user_memory` 是夹具（真实路径要跑一次完整生成并让 agent 调工具）。断言仍然只走界面，不要用接口自证。
- 列表项用 `getByRole('listitem').filter({ hasText })`；编辑态下的行改用 `has: page.getByLabel('记忆内容')` 定位，否则会同时匹配到两个列表项。
- 删除有二次确认，确认按钮文字是「删除」（中间可能带空格）。
- 空态和列表态文案不同，断言前先确认这个账号有没有种子数据。
- 会话要先用 API 登录，直接 `page.goto('/user/me')` 会跳到登录页。
