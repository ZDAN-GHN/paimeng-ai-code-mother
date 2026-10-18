/** 一次性旧平台 UI 对照验收；不属于日常启动或测试入口，使用条件见 scripts/README.md。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Run from paimeng-ai-code-agent after npm run build. All business requests are fixtures.
const output = resolve('runtime/parity-fixes/screenshots');
const origins = { legacy: 'http://127.0.0.1:4173', current: 'http://localhost:3010' };
const creator = { id: '1', userAccount: 'parity_admin', userName: '对照管理员', userRole: 'admin', userAvatar: null, userProfile: '测试简介', createTime: '2026-10-01 12:00:00', updateTime: '2026-10-01 12:00:00' };
const app = { id: '777', appName: '复刻对照应用', initPrompt: '创建一个个人博客', codeGenType: 'html', userId: '1', user: creator, cover: null, priority: 99, deployKey: 'abc123', deployedTime: '2026-10-02 12:00:00', createTime: '2026-10-01 12:00:00', updateTime: '2026-10-02 12:00:00', editTime: '2026-10-02 12:00:00', sourceAvailable: true, previewAvailable: true, previewUrl: 'http://127.0.0.1:3001/preview/html_777/', deployUrl: 'http://127.0.0.1:3001/deploy/abc123/' };
const histories = [{ id: '12', appId: app.id, userId: '1', messageType: 'ai', message: '# 生成完成\n\n**粗体说明**\n\n```html\n<h1>博客</h1>\n```', createTime: '2026-10-02 12:00:00' }, { id: '11', appId: app.id, userId: '1', messageType: 'user', message: app.initPrompt, createTime: '2026-10-01 12:00:00' }];
const uiMessages = [...histories].reverse().map(row => ({ id: row.id, role: row.messageType === 'user' ? 'user' : 'assistant', parts: [{ type: 'text', text: row.message }] }));
const summary = [];
const owned = [];
const controller = new AbortController();
const budget = setTimeout(() => controller.abort(new Error('页面对照超过 6 分钟预算')), 6 * 60 * 1000);
const onSignal = () => controller.abort(new Error('页面对照被中断'));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, onSignal);
let browser;
let serverLog = '';
let outcome = 'failed';

const delay = ms => new Promise(done => setTimeout(done, ms));
async function bounded(work) {
  controller.signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([work, aborted]); }
  finally { controller.signal.removeEventListener('abort', onAbort); }
}
function portOpen(port) {
  return new Promise((done, reject) => {
    const probe = createConnection({ host: '127.0.0.1', port });
    probe.setTimeout(1000);
    probe.once('connect', () => { probe.destroy(); done(true); });
    probe.once('timeout', () => { probe.destroy(); reject(new Error(`端口 ${port} 探测超时`)); });
    probe.once('error', error => { probe.destroy(); error.code === 'ECONNREFUSED' ? done(false) : reject(error); });
  });
}
function start(args, cwd) {
  const child = spawn(process.execPath, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const completion = new Promise(done => child.once('close', done));
  owned.push({ child, completion });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', text => { serverLog = (serverLog + text).slice(-30000); });
  child.once('error', error => controller.abort(error));
  child.once('exit', code => { if (!controller.signal.aborted) controller.abort(new Error(`页面服务提前退出：${code}`)); });
}
function groupAlive(child) {
  if (!child.pid) return false;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
function signalGroup(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function waitForPage(origin) {
  for (;;) {
    controller.signal.throwIfAborted();
    try {
      const response = await fetch(origin, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1500)]) });
      await response.arrayBuffer();
      if (response.ok) return;
    } catch { controller.signal.throwIfAborted(); }
    await bounded(delay(200));
  }
}

async function measure(page) {
  return page.evaluate(() => {
    const style = selector => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const css = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return { width: rect.width, height: rect.height, fontSize: css.fontSize, background: css.backgroundImage, backgroundColor: css.backgroundColor, radius: css.borderRadius, shadow: css.boxShadow, position: css.position, gap: css.gap, columns: css.gridTemplateColumns, direction: css.flexDirection, flex: css.flex, textAlign: css.textAlign };
    };
    return {
      headings: [...document.querySelectorAll('h1,h2,h3')].map(el => el.textContent),
      tableHeaders: [...document.querySelectorAll('thead th')].map(el => el.textContent),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      markdownCodeBlocks: document.querySelectorAll('.markdown-content pre,.markdown-body pre').length,
      previewLinks: [...document.querySelectorAll('.preview-bar a')].map(el => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return { text: el.textContent, lines: new Set([...range.getClientRects()].map(rect => rect.top)).size };
      }),
      header: style('header'), logo: style('header .logo,header .brand-logo'), footer: style('footer'),
      hero: style('.hero-title'), input: style('textarea.prompt-input'), card: style('.app-preview'), grid: style('.app-grid'),
      auth: style('#userLoginPage,#userRegisterPage,.auth-page'), authTips: style('.tips,.auth-tips'),
      chat: style('.chat-section,.chat-panel'), preview: style('.preview-section,.preview-panel'),
      edit: style('#appEditPage,[class*="editPage"]'),
      editCards: document.querySelectorAll('#appEditPage .ant-card,[class*="editPage"] .ant-card').length,
      admin: style('#userManagePage,#appManagePage,[class*="adminPage"]'),
    };
  });
}

async function capture() {
  browser = await chromium.launch({ headless: true });
  for (const variant of ['legacy', 'current']) {
    const origin = origins[variant];
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    context.setDefaultTimeout(15000);
    let nonOwner = false;
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.startsWith('/preview/') || url.pathname.startsWith('/api/static/')) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<html><body><h1>预览应用</h1></body></html>' });
      if (!url.pathname.startsWith('/api/')) {
        // No outside images, model endpoints or other network dependencies.
        return [new URL(origin).origin, origins.legacy, new URL(origins.current).origin].includes(url.origin) ? route.continue() : route.abort();
      }
      const path = url.pathname.slice(5);
      const headers = { 'access-control-allow-origin': request.headers().origin || origin, 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      let data = null, code = 0, status = 200, message = 'ok';
      if (path === 'user/get/login') data = nonOwner ? { ...creator, id: '2', userRole: 'user' } : creator;
      else if (path === 'app/get/vo' || path === 'app/admin/get/vo') data = app;
      else if (path === 'app/generation') data = { id: 'completed-fixture', appId: app.id, status: 'ready', error: null };
      else if (path === 'app/messages') data = uiMessages;
      else if (path.includes('list/page/vo')) data = { records: path.startsWith('user/') ? [creator] : [app], totalRow: 1, pageNumber: 1, pageSize: 10 };
      else { code = 40900; status = 409; message = '页面对照禁止生成和业务写入：' + path; }
      if (nonOwner && (path === 'app/messages' || path === 'app/generation')) { code = 40300; status = variant === 'legacy' ? 200 : 403; message = '无权查看该应用的对话历史'; data = null; }
      return route.fulfill({ status, headers, json: { code, data, message } });
    });
    const page = await context.newPage();
    for (const [name, path] of [['home', '/'], ['login', '/user/login'], ['register', '/user/register'], ['users', '/admin/userManage'], ['apps', '/admin/appManage'], ['edit', '/app/edit/777'], ['chat', '/app/chat/777']]) {
      await page.goto(origin + path);
      await page.locator('header').getByText(creator.userName, { exact: true }).first().waitFor();
      if (name === 'login' || name === 'register') await page.locator('input').first().waitFor();
      else if (name === 'edit' && variant === 'current') await page.getByLabel('应用名称', { exact: true }).waitFor();
      else await page.getByText(name === 'chat' ? '粗体说明' : name === 'edit' ? '初始提示词' : name === 'home' ? 'AI 应用生成平台' : name === 'users' ? creator.userAccount : name === 'apps' ? app.appName : app.initPrompt, { exact: name === 'home' }).first().waitFor({ state: 'attached' });
      if (name === 'home') await page.locator('.app-card').nth(1).waitFor();
      if (name === 'chat') await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some(input => !input.disabled));
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: resolve(output, `${variant}-${name}-desktop.png`), fullPage: true });
      const row = { variant, name, viewport: 'desktop', ...await measure(page) };
      summary.push(row);
      if (name === 'home') {
        await page.getByRole('button', { name: '个人博客网站', exact: true }).click();
        row.quickPrompt = await page.locator('textarea').first().inputValue();
      }
      if (name === 'home' || name === 'chat') {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: resolve(output, `${variant}-${name}-mobile.png`), fullPage: true });
        summary.push({ variant, name, viewport: 'mobile', ...await measure(page) });
        await page.setViewportSize({ width: 1440, height: 1000 });
      }
      console.log(`${variant} ${name} 已截图`);
    }
    nonOwner = true;
    await page.goto(origin + '/app/chat/777');
    await page.getByRole('heading', { name: app.appName, exact: true }).waitFor();
    if (variant === 'current') await page.getByText('对话历史暂不可读取：无权查看该应用的对话历史', { exact: true }).waitFor();
    summary.push({ variant, name: 'non-owner', showsAppName: await page.getByRole('heading', { name: app.appName, exact: true }).count(), ...await measure(page) });
    await page.screenshot({ path: resolve(output, `${variant}-non-owner.png`), fullPage: true });
    await context.close();
  }
  const get = (variant, name, viewport = 'desktop') => summary.find(row => row.variant === variant && row.name === name && row.viewport === viewport);
  const oldHome = get('legacy', 'home'), newHome = get('current', 'home');
  assert.equal(summary.length, 22);
  assert.equal(newHome.quickPrompt, oldHome.quickPrompt);
  assert.equal(newHome.hero.fontSize, '56px');
  assert.equal(newHome.input.radius, '16px');
  assert.equal(newHome.input.fontSize, '16px');
  assert.equal(newHome.input.backgroundColor, oldHome.input.backgroundColor);
  assert.equal(newHome.card.height, 180);
  assert.equal(newHome.grid.gap, '24px');
  assert.equal(newHome.logo.height, 64);
  assert.equal(get('current', 'home', 'mobile').hero.fontSize, '32px');
  for (const name of ['login', 'register']) assert.equal(get('current', name).auth.width, 720);
  assert.equal(get('current', 'edit').edit.width, 1000);
  assert.equal(get('current', 'edit').editCards, 2);
  const mobilePreviewLinks = get('current', 'chat', 'mobile').previewLinks;
  assert.ok(mobilePreviewLinks.some(link => link.text === '访问作品'));
  for (const link of mobilePreviewLinks) assert.equal(link.lines, 1);
  for (const variant of ['legacy', 'current']) {
    assert.equal(get(variant, 'chat').markdownCodeBlocks, 1);
    assert.equal(summary.find(row => row.variant === variant && row.name === 'non-owner').showsAppName, 1);
    for (const name of ['home', 'chat']) assert.equal(get(variant, name, 'mobile').horizontalOverflow, false);
  }
  outcome = 'passed';
  console.log('22 张页面对照与模板、Markdown、公开详情、布局尺寸断言通过');
}

try {
  await mkdir(output, { recursive: true });
  await access(resolve('.next/BUILD_ID'));
  for (const port of [4173, 3010]) if (await bounded(portOpen(port))) throw new Error(`端口 ${port} 已占用，拒绝复用未知服务`);
  start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4173', '--strictPort'], resolve('../archive/paimeng-ai-code-mother-frontend'));
  start(['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3010'], process.cwd());
  for (const origin of Object.values(origins)) await bounded(waitForPage(origin));
  await bounded(capture());
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  clearTimeout(budget);
  controller.abort(new Error('页面对照结束'));
  await browser?.close();
  for (const { child } of owned) signalGroup(child, 'SIGTERM');
  const deadline = Date.now() + 5000;
  while (owned.some(({ child }) => groupAlive(child)) && Date.now() < deadline) await delay(100);
  for (const { child } of owned) if (groupAlive(child)) signalGroup(child, 'SIGKILL');
  await Promise.race([Promise.all(owned.map(({ completion }) => completion)), delay(2000)]);
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ outcome, method: '真实 Vue 与生产 Next 前端，相同拦截 API fixture；无模型调用或业务数据库写入；尺寸和 DOM 检查，无逐像素差分', summary, serverLog }, null, 2));
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, onSignal);
}
