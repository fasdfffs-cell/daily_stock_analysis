// Local-only, fixture-only browser acceptance. Never seeds a real user's auth.
import { chromium } from '../apps/dsa-web/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const base = process.argv[2];
const output = process.argv[3];
if (!base || !output || !['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) {
  throw Error('Supply a loopback fixture URL and ignored evidence directory');
}
fs.mkdirSync(output, { recursive: true });
const receipt = { fixture: true, sandbox: true, externalRequests: [], pageErrors: [], assertions: [], screenshots: [] };
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, timeout: 20000 });
  receipt.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  const authStatus = await (await context.request.get(`${base}/api/v1/auth/status`)).json();
  if (authStatus.demoFixture !== true) throw Error('Refusing to set a password on a non-fixture instance');
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(base) || url.startsWith('data:') || url.startsWith('blob:')) await route.continue();
    else { receipt.externalRequests.push(url); await route.abort(); }
  });
  const page = await context.newPage();
  page.on('pageerror', error => receipt.pageErrors.push(error.message));
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.screenshot({ path: path.join(output, 'login-blank.png'), fullPage: true });
  const passwordFields = page.locator('input[type="password"]');
  const fixturePassword = 'FixtureOnly-NotARealSecret';
  await passwordFields.nth(0).fill(fixturePassword);
  if (await passwordFields.count() > 1) await passwordFields.nth(1).fill(fixturePassword);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(url => url.pathname === '/', { timeout: 20000 });
  await page.getByText('私人手动研究工作台', { exact: false }).waitFor({ timeout: 20000 });
  receipt.assertions.push('first password setup and authenticated original React shell');
  const removed = await context.request.post(`${base}/api/v1/stocks/watchlist/remove`, { data: { stock_code: 'NVDA' }, headers: { Origin: base } });
  if (removed.status() !== 200) throw Error('Could not reset fixture-only watchlist');
  await page.evaluate(() => {
    window.__workbenchEvents = [];
    window.__workbenchStream = new EventSource('/api/v1/analysis/tasks/stream');
    for (const name of ['connected', 'task_created', 'task_started', 'task_progress', 'task_completed', 'task_failed', 'heartbeat']) {
      window.__workbenchStream.addEventListener(name, event => window.__workbenchEvents.push({ type: name, data: JSON.parse(event.data) }));
    }
  });
  await page.waitForFunction(() => window.__workbenchEvents.some(event => event.type === 'connected'), null, { timeout: 10000 });
  receipt.assertions.push('cookie-authenticated live SSE connected');
  const input = page.getByPlaceholder('输入股票代码或名称，如 600519、贵州茅台、AAPL');
  await input.fill('NVDA');
  await page.getByRole('button', { name: '分析', exact: true }).click();
  await page.waitForFunction(() => window.__workbenchEvents.some(event => event.type === 'task_completed' && event.data.status === 'completed'), null, { timeout: 20000 });
  receipt.assertions.push('manual analysis button -> original async queue -> SSE progress/completion (DEMO only)');
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await page.getByTestId('home-stock-bar').getByText('NVDA', { exact: true }).first().click();
  await page.getByText('DEMO — 离线界面验收样例', { exact: false }).waitFor({ timeout: 15000 });
  await page.getByText('实际模型：DEMO/offline-fixture', { exact: false }).waitFor({ timeout: 15000 });
  receipt.assertions.push('original history selection and detailed report with DEMO/date/actual-model metadata');
  await page.screenshot({ path: path.join(output, 'workbench-desktop.png'), fullPage: true });
  // Use the original report watchlist button rather than a fabricated UI.
  const addWatchlist = page.getByRole('button', { name: /加入自选|添加自选/ }).first();
  const added = page.waitForResponse(response => response.url().endsWith('/api/v1/stocks/watchlist/add') && response.status() === 200);
  await addWatchlist.click();
  await added;
  receipt.assertions.push('original report watchlist button clicked and write returned 200');
  const watchlist = await context.request.get(`${base}/api/v1/stocks/watchlist`);
  receipt.watchlist = await watchlist.json();
  if (!receipt.watchlist.stock_codes.includes('NVDA')) throw Error('Watchlist mutation not persisted');
  const history = await context.request.get(`${base}/api/v1/history`);
  receipt.historyStatus = history.status();
  const settings = await context.request.get(`${base}/api/v1/system/config/export`);
  if (settings.status() !== 403) throw Error('Configuration export must remain denied');
  await page.goto(`${base}/settings`, { waitUntil: 'domcontentloaded' });
  await page.getByText('此功能在私人手动模式下已禁用').waitFor();
  receipt.assertions.push('retained settings tab disabled; backend export 403');
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  receipt.mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (receipt.mobileOverflow) throw Error('Mobile viewport overflow');
  await page.screenshot({ path: path.join(output, 'workbench-mobile.png'), fullPage: true });
  receipt.assertions.push('mobile viewport without horizontal overflow');
  // Real 30-second heartbeat; not an accelerated mock or buffered response.
  await page.evaluate(() => {
    window.__workbenchHeartbeat = false;
    window.__heartbeatSource = new EventSource('/api/v1/analysis/tasks/stream');
    window.__heartbeatSource.addEventListener('heartbeat', () => { window.__workbenchHeartbeat = true; });
  });
  await page.waitForFunction(() => window.__workbenchHeartbeat, null, { timeout: 40000 });
  receipt.assertions.push('actual SSE 30-second heartbeat survived streaming');
  await page.evaluate(() => { window.__heartbeatSource.close(); window.__workbenchStream?.close(); });
  if (receipt.pageErrors.length) throw Error(`Page errors: ${receipt.pageErrors.join('; ')}`);
  receipt.passed = true;
} catch (error) {
  receipt.passed = false;
  receipt.error = error.message;
  throw error;
} finally {
  if (browser) await browser.close();
  receipt.screenshots = ['login-blank.png', 'workbench-desktop.png', 'workbench-mobile.png'].filter(file => fs.existsSync(path.join(output, file)));
  fs.writeFileSync(path.join(output, 'browser-acceptance.json'), JSON.stringify(receipt, null, 2));
}
