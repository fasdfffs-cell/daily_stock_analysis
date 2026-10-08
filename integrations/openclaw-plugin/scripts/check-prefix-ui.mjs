// Adapted from scripts/check_workbench_ui.mjs; loopback + DEMO marker before auth setup.
import { chromium } from '../../../apps/dsa-web/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const origin = process.argv[2], output = process.argv[3];
const prefix = '/plugins/dsa-workbench/app', app = origin + prefix;
if (!origin || !output || !['127.0.0.1', 'localhost'].includes(new URL(origin).hostname) || new URL(origin).origin !== origin) throw Error('Explicit loopback origin and private evidence directory required');
fs.mkdirSync(output, { recursive: true });
const receipt = { fixture: true, chromiumSandbox: true, entry: prefix + '/', loopbackHttpSecureCookieProofOnly: true, edgeTlsVerified: false, liveGatewayLoaded: false, externalRequestCount: 0, pageErrors: [], assertions: [], screenshots: [] };
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, timeout: 20000 });
  receipt.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(origin + '/') || url.startsWith('data:') || url.startsWith('blob:')) await route.continue();
    else { receipt.externalRequestCount++; await route.abort(); }
  });
  const page = await context.newPage();
  page.on('pageerror', error => receipt.pageErrors.push(error.message));
  await page.goto(origin + '/fixture-host', { waitUntil: 'domcontentloaded', timeout: 20000 });
  const status = await page.evaluate(async url => (await fetch(url)).json(), prefix + '/api/v1/auth/status');
  assert.equal(status.demoFixture, true, 'Refuse to initialize non-fixture authentication');
  assert.equal(status.authEnabled, true); assert.equal(status.passwordSet, false, 'Refuse to reuse auth state');
  const frame = page.frameLocator('iframe');
  await frame.getByRole('heading', { name: '股票研究', exact: true }).waitFor();
  assert.equal(await frame.locator('input[readonly]').inputValue(), prefix + '/');
  assert.equal(await frame.locator('form,script').count(), 0);
  await frame.getByText('#2', { exact: true }).waitFor();
  await frame.getByText('2026-10-07', { exact: true }).waitFor();
  receipt.savedReportActualModel = await frame.locator('.model').first().textContent();
  assert.match(receipt.savedReportActualModel, /gpt-6\.1-sol/);
  const beforePages = context.pages().length;
  await frame.getByRole('link', { name: '打开完整工作台' }).click();
  await page.waitForTimeout(600);
  receipt.iframePopupBlocked = context.pages().length === beforePages;
  assert.equal(receipt.iframePopupBlocked, true);
  assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts');
  await page.screenshot({ path: path.join(output, 'sidebar-sandbox.png'), fullPage: true });
  receipt.assertions.push('allow-scripts-only iframe: original saved NVDA #2/model/date escaped report, copyable token-free path, popup actually blocked, no writes');
  await page.goto(app + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  assert.ok(new URL(page.url()).pathname.startsWith(prefix + '/login'));
  await page.screenshot({ path: path.join(output, 'prefix-login-blank.png'), fullPage: true });
  const passwordFields = page.locator('input[type="password"]');
  const fixturePassword = 'Fixture-' + randomBytes(20).toString('base64url');
  await passwordFields.nth(0).fill(fixturePassword);
  if (await passwordFields.count() > 1) await passwordFields.nth(1).fill(fixturePassword);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(url => [prefix, prefix + '/'].includes(url.pathname), { timeout: 20000 });
  await page.getByText('私人手动研究工作台', { exact: false }).waitFor({ timeout: 20000 });
  const cookies = await context.cookies();
  const session = cookies.find(c => c.name === 'dsa_session');
  assert.ok(session && session.httpOnly && session.secure && session.sameSite === 'Lax' && session.path === prefix + '/');
  receipt.cookieAttributes = { httpOnly: session.httpOnly, secure: session.secure, sameSite: session.sameSite, path: session.path };
  receipt.assertions.push('prefixed original React login and route basename; Secure/HttpOnly/SameSite=Lax prefix cookie accepted by localhost Chrome');
  await page.evaluate(async url => { const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stock_code: 'NVDA' }) }); if (!response.ok) throw Error('fixture watchlist reset failed ' + response.status); }, prefix + '/api/v1/stocks/watchlist/remove');
  const streamStarted = Date.now();
  await page.evaluate(streamUrl => {
    window.__workbenchEvents = [];
    window.__workbenchStream = new EventSource(streamUrl, { withCredentials: true });
    for (const type of ['connected', 'task_created', 'task_started', 'task_progress', 'task_completed', 'task_failed', 'heartbeat']) window.__workbenchStream.addEventListener(type, event => window.__workbenchEvents.push({ type, data: JSON.parse(event.data), at: Date.now() }));
  }, prefix + '/api/v1/analysis/tasks/stream');
  await page.waitForFunction(() => window.__workbenchEvents.some(e => e.type === 'connected'), null, { timeout: 10000 });
  await page.getByPlaceholder('输入股票代码或名称，如 600519、贵州茅台、AAPL').fill('NVDA');
  await page.getByRole('button', { name: '分析', exact: true }).click();
  await page.waitForFunction(() => window.__workbenchEvents.some(e => e.type === 'task_completed' && e.data.status === 'completed'), null, { timeout: 20000 });
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await page.getByTestId('home-stock-bar').getByText('NVDA', { exact: true }).first().click();
  await page.getByText('DEMO — 离线交互验收', { exact: false }).first().waitFor({ timeout: 15000 });
  await page.getByText('实际模型：DEMO/offline-fixture', { exact: false }).waitFor({ timeout: 15000 });
  receipt.assertions.push('manual original UI button -> original async queue/SSE completion -> original history/detail DEMO/date/actual model');
  await page.screenshot({ path: path.join(output, 'prefix-workbench-desktop.png'), fullPage: true });
  const added = page.waitForResponse(r => r.url().endsWith(prefix + '/api/v1/stocks/watchlist/add') && r.status() === 200);
  await page.getByRole('button', { name: /加入自选|添加自选/ }).first().click(); await added;
  const checks = await page.evaluate(async base => {
    const watchlist = await (await fetch(base + '/api/v1/stocks/watchlist')).json();
    const history = await fetch(base + '/api/v1/history'); const denied = await fetch(base + '/api/v1/system/config/export');
    const csrf = await fetch(base + '/api/v1/stocks/watchlist/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stock_code: 'NVDA' }), credentials: 'omit' });
    return { watchlist, history: history.status, configExport: denied.status, anonymousWrite: csrf.status };
  }, prefix);
  assert.ok(checks.watchlist.stock_codes.includes('NVDA')); assert.equal(checks.history, 200); assert.equal(checks.configExport, 403); assert.equal(checks.anonymousWrite, 401);
  receipt.apiChecks = checks;
  receipt.assertions.push('original report watchlist button writes and reads back; config export 403 and anonymous write 401');
  await page.waitForFunction(() => window.__workbenchEvents.some(e => e.type === 'heartbeat'), null, { timeout: 40000 });
  // Keep the same stream alive beyond the former 15s upstream deadline, >=35s total.
  const remainder = 35000 - (Date.now() - streamStarted); if (remainder > 0) await page.waitForTimeout(remainder);
  receipt.sse = await page.evaluate(() => ({ types: [...new Set(window.__workbenchEvents.map(e => e.type))], heartbeatCount: window.__workbenchEvents.filter(e => e.type === 'heartbeat').length, readyState: window.__workbenchStream.readyState }));
  receipt.sse.durationMs = Date.now() - streamStarted;
  assert.ok(receipt.sse.heartbeatCount >= 1); assert.equal(receipt.sse.readyState, 1); assert.ok(receipt.sse.durationMs >= 35000);
  await page.evaluate(() => window.__workbenchStream.close());
  receipt.assertions.push('same-prefix real original 30-second SSE heartbeat, unbuffered connection alive >=35s, then explicit close');
  await page.goto(app + '/settings', { waitUntil: 'domcontentloaded' }); await page.getByText('此功能在私人手动模式下已禁用').waitFor();
  await page.goto(app + '/', { waitUntil: 'domcontentloaded' }); await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(400);
  receipt.mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1); assert.equal(receipt.mobileOverflow, false);
  await page.screenshot({ path: path.join(output, 'prefix-workbench-mobile.png'), fullPage: true });
  assert.deepEqual(receipt.pageErrors, []); assert.equal(receipt.externalRequestCount, 0);
  receipt.passed = true;
} catch (error) { receipt.passed = false; receipt.error = error.message; throw error; }
finally {
  if (browser) await browser.close();
  receipt.screenshots = ['sidebar-sandbox.png', 'prefix-login-blank.png', 'prefix-workbench-desktop.png', 'prefix-workbench-mobile.png'].filter(file => fs.existsSync(path.join(output, file)));
  fs.writeFileSync(path.join(output, 'browser-acceptance.json'), JSON.stringify(receipt, null, 2));
}
