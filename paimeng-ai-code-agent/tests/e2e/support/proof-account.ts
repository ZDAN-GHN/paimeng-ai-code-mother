import { expect, type Page } from '@playwright/test';
import { appOrigin } from './app-origin';

/** Account used by the reliability proofs; the password is supplied at run time, never stored. */
export const proofAccount = process.env.E2E_PROOF_ACCOUNT ?? 'paimeng666';
const suppliedPassword = process.env.E2E_PROOF_PASSWORD;
if (!suppliedPassword) {
  throw new Error('E2E_PROOF_PASSWORD is required for the reliability proof; pass it through the environment.');
}
const proofPassword: string = suppliedPassword;

/**
 * Register the proof account if this test database does not have it, then sign in
 * through the real login form. Returns the session user for the proof artifact.
 */
export async function loginAsProofAccount(page: Page): Promise<{ id: string; userAccount: string }> {
  const origin = appOrigin();
  const registered = await page.request.post('/api/user/register', {
    headers: { origin },
    data: { userAccount: proofAccount, userPassword: proofPassword, checkPassword: proofPassword },
  });
  if (![200, 409].includes(registered.status())) {
    throw new Error(`Proof account registration failed with HTTP ${registered.status()}`);
  }

  await page.goto('/user/login');
  await page.getByLabel('账号', { exact: true }).fill(proofAccount);
  await page.getByLabel('密码', { exact: true }).fill(proofPassword);
  await page.locator('form').getByRole('button', { name: /^登\s*录$/ }).click();
  await expect(page).toHaveURL('/', { timeout: 20_000 });

  const session = await page.request.get('/api/user/get/login', { headers: { origin } });
  expect(session.ok(), 'Proof account login must create a real session').toBe(true);
  const body = await session.json();
  expect(body.data?.userAccount, 'Session must belong to the proof account').toBe(proofAccount);
  return body.data as { id: string; userAccount: string };
}
