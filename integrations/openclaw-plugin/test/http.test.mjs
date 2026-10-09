import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, createServer, request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createDsaHttpHandler, staticAsset } from '../dist/http.js';
import { parseConfig } from '../dist/config.js';
import { ReportData } from '../dist/data.js';
import { withDsaRouteAccess } from '../dist/access.js';
import { APP_BASE, ROUTE_ROOT } from '../dist/policy.js';
import { rewrittenCookies, rewrittenLocation } from '../dist/proxy.js';
import { nativeRequest } from './native-request.mjs';

async function listen(server) { await new Promise(r => server.listen(0, '127.0.0.1', r)); return server.address().port; }
async function close(server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
const call = (port, path, options = {}) => nativeRequest({ port, path, ...options });
function seeded(path) {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE analysis_history(id INTEGER PRIMARY KEY, code TEXT, name TEXT, created_at TEXT, report_type TEXT, analysis_summary TEXT, raw_result TEXT, context_snapshot TEXT)');
  db.prepare('INSERT INTO analysis_history VALUES(?,?,?,?,?,?,?,?)').run(2, 'NVDA', 'DEMO NVDA', '2026-10-08 00:00:00', 'detailed', '<img src=x onerror=alert(1)> DEMO original summary', JSON.stringify({ model_used: 'DEMO/offline-fixture', market_snapshot: { date: '2026-10-07' } }), '{}'); db.close();
}

test('explicit admin configuration pins issuer and keeps email optional', () => {
  const dbPath = join(tmpdir(), 'fixture.db');
  const staticDir = join(tmpdir(), 'fixture-app');
  assert.equal(parseConfig({ dbPath, staticDir, cloudflareAccessHost: 'dsa.example.invalid', cloudflareAccessIssuer: 'https://team.cloudflareaccess.com', cloudflareAccessAudience: 'fixture' }).cloudflareAccessEmail, '');
  for (const input of [{}, { dbPath }, { dbPath: 'relative.db', staticDir }, { dbPath, staticDir: 'relative' }, { dbPath, staticDir, targetUrl: 'https://other.invalid' }, { dbPath, staticDir, cloudflareAccessHost: 'dsa.example.invalid' }]) assert.throws(() => parseConfig(input));
  for (const issuer of ['http://team.cloudflareaccess.com', 'https://team.cloudflareaccess.com/keys', 'https://team.cloudflareaccess.com.evil.invalid', 'https://other.invalid', 'https://team.cloudflareaccess.com:443', 'https://team.cloudflareaccess.com/']) assert.throws(() => parseConfig({ dbPath, staticDir, cloudflareAccessHost: 'dsa.example.invalid', cloudflareAccessAudience: 'fixture', cloudflareAccessEmail: 'owner@example.invalid', cloudflareAccessIssuer: issuer }));
});

test('original report view is read-only; assets reject hidden paths and all symlinks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsa-assets-')); const file = join(root, 'report.db'); seeded(file);
  const before = readFileSync(file); const row = new ReportData(file).latest()[0];
  assert.equal(row.id, 2); assert.equal(row.actualModel, 'DEMO/offline-fixture'); assert.equal(row.dataDate, '2026-10-07'); assert.equal(row.sourceViewStatus, 'saved-report'); assert.match(row.quoteStatus, /实时行情缺失/); assert.deepEqual(readFileSync(file), before);
  assert.throws(() => new ReportData(join(root, 'missing.db')).latest());
  writeFileSync(join(root, 'asset.js'), 'ok'); assert.equal((await staticAsset(root, 'asset.js')).toString(), 'ok');
  symlinkSync(file, join(root, 'leak.js')); await assert.rejects(staticAsset(root, 'leak.js'));
  symlinkSync(root, join(root, 'escape')); await assert.rejects(staticAsset(root, 'escape/asset.js'));
  await assert.rejects(staticAsset(root, '../report.db')); await assert.rejects(staticAsset(root, '.env')); rmSync(root, { recursive: true });
});

test('native guarded routes, Origin/CSRF, cookies, redirects and SSE', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dsa-http-')); const dbPath = join(root, 'report.db'); seeded(dbPath);
  const staticDir = join(root, 'app'); mkdirSync(join(staticDir, 'assets'), { recursive: true });
  writeFileSync(join(staticDir, 'index.html'), `<html><script type="module" src="${APP_BASE}/assets/main.js"></script></html>`);
  writeFileSync(join(staticDir, 'assets/main.js'), '/* DEMO native fixture */'); writeFileSync(join(staticDir, 'stocks.index.json'), '[]');
  const seen = []; let scenario = ''; let authEnabled = true; let sseClosed;
  const backend = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString(); seen.push({ path: req.url, method: req.method, headers: req.headers, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v1/auth/status') return res.end(JSON.stringify({ authEnabled, loggedIn: req.headers.cookie === 'dsa_session=fixture-session' }));
    if (req.url === '/api/v1/auth/login') { res.setHeader('Set-Cookie', ['dsa_session=fixture-session; Path=/; HttpOnly; SameSite=Lax', 'gateway_cookie=never-forward; Path=/']); return res.end('{"success":true}'); }
    if (scenario) { res.statusCode = 303; res.setHeader('Content-Type', 'text/plain'); res.setHeader('Location', scenario === 'external' ? 'https://other.invalid/login' : '/login'); return res.end('redirect'); }
    if (req.url === '/api/v1/analysis/tasks/stream') { res.setHeader('Content-Type', 'text/event-stream'); res.write('event: connected\ndata: {"demo":true}\n\n'); const timer = setTimeout(() => res.write('event: heartbeat\ndata: {"demo":true}\n\n'), 80); res.on('close', () => { clearTimeout(timer); sseClosed?.(); }); return; }
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Authorization', 'never-forward'); res.end('{"demo":true}');
  });
  const targetPort = await listen(backend); const config = parseConfig({ dbPath, staticDir });
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const issuer = 'https://team-fixture.cloudflareaccess.com'; const host = 'dsa.example.invalid'; const email = 'owner@example.invalid';
  const access = { ...config, cloudflareAccessHost: host, cloudflareAccessIssuer: issuer, cloudflareAccessAudience: 'fixture-aud', cloudflareAccessEmail: email, jwksFetch: async () => new Response(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' }] })) };
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url'); const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: 'fixture-aud', email, exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
  const token = `${head}.${claims}.${sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), privateKey).toString('base64url')}`;
  const app = createServer(withDsaRouteAccess(createDsaHttpHandler(config, { upstreamPort: targetPort }), access)); const port = await listen(app); const origin = `http://127.0.0.1:${port}`;
  const authenticated = { cookie: 'dsa_session=fixture-session', origin, 'content-type': 'application/json' };
  try {
    await t.test('safe escaped sidebar, no fetch/form/script, explicit open/copy path', async () => {
      const result = await call(port, `${ROUTE_ROOT}/`); assert.equal(result.status, 200); assert.match(result.text, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.match(result.text, /DEMO\/offline-fixture/); assert.match(result.text, /2026-10-07/); assert.match(result.text, /saved-report/); assert.match(result.text, /打开完整工作台/); assert.match(result.text, /value="\/plugins\/dsa-workbench\/app\/"/); assert.doesNotMatch(result.text, /<script|<form|fetch\(|postMessage/); assert.match(result.headers['content-security-policy'], /connect-src 'none'/); assert.equal((await call(port, `${ROUTE_ROOT}/`, { method: 'POST' })).status, 405);
    });
    await t.test('every resource/API uses full JWT guard; spoof/unknown authority denied', async () => {
      for (const path of [`${ROUTE_ROOT}/`, `${ROUTE_ROOT}/overview.css`, `${APP_BASE}/`, `${APP_BASE}/assets/main.js`, `${APP_BASE}/api/v1/auth/status`]) {
        assert.equal((await call(port, path, { headers: { host, 'x-forwarded-proto': 'https' } })).status, 401);
        assert.equal((await call(port, path, { headers: { host, 'x-forwarded-proto': 'https', 'cf-access-jwt-assertion': token } })).status, 200);
      }
      assert.equal((await call(port, `${ROUTE_ROOT}/`, { headers: { host: 'unknown.invalid' } })).status, 401); assert.equal((await call(port, `${ROUTE_ROOT}/`, { headers: { 'x-forwarded-for': '203.0.113.1' } })).status, 401);
    });
    await t.test('bad paths, queries, methods and disabled APIs never reach target', async () => {
      for (const path of [`${APP_BASE}/../index.html`, `${APP_BASE}/%2e%2e/index.html`, `${APP_BASE}/.env`, `${APP_BASE}//assets/main.js`, 'https://other.invalid/path']) assert.equal((await call(port, path)).status, 400);
      for (const path of ['/system/config/export', '/auth/settings', '/agent/chat', '/portfolio/import/parse', '/analysis/market-review', '/stocks/parse-import']) assert.equal((await call(port, `${APP_BASE}/api/v1${path}`, { headers: authenticated })).status, 403);
      assert.equal((await call(port, `${APP_BASE}/api/v1/history`, { method: 'DELETE', headers: authenticated })).status, 405);
      for (const query of ['url=https%3A%2F%2Fother.invalid', 'limit=101', 'limit=1&limit=2']) assert.equal((await call(port, `${APP_BASE}/api/v1/history?${query}`)).status, 400);
      assert.equal((await call(port, `${APP_BASE}/assets/main.js.map`)).status, 404); assert.equal((await call(port, `${APP_BASE}/login`)).headers['x-frame-options'], 'DENY');
    });
    await t.test('native research exact methods keep cookie, Origin and request identity guards', async () => {
      const routes = [
        ['/system/config', 'GET', ''], ['/system/scheduler/status', 'GET', ''],
        ['/portfolio/accounts', 'GET', ''], ['/backtest/results', 'GET', ''],
        ['/system/config', 'PUT', JSON.stringify({ config_version: 'fixture', reload_now: true, items: [{ key: 'SCHEDULE_TIME', value: '19:00' }] })],
        ['/portfolio/accounts', 'POST', '{"name":"DEMO ledger","market":"us","base_currency":"USD"}'],
        ['/portfolio/trades', 'POST', '{"account_id":1,"symbol":"QQQ","trade_date":"2026-10-08","side":"buy","quantity":1,"price":100}'],
        ['/backtest/run', 'POST', '{"code":"QQQ","limit":10}'],
        ['/history/by-code/QQQ', 'DELETE', '{}'], ['/portfolio/accounts/1', 'DELETE', '{}'],
      ];
      for (const [path, method, body] of routes) {
        assert.equal((await call(port, `${APP_BASE}/api/v1${path}`, { method, headers: { ...authenticated, host, 'x-forwarded-proto':'https' }, body })).status, 401);
        assert.equal((await call(port, `${APP_BASE}/api/v1${path}`, { method, headers: authenticated, body })).status, 200);
        if (!['GET','HEAD'].includes(method)) assert.equal((await call(port, `${APP_BASE}/api/v1${path}`, { method, headers: { ...authenticated, origin:'https://evil.invalid' }, body })).status, 403);
      }
      for (const key of ['OPENAI_API_KEY','ADMIN_AUTH_ENABLED','STOCK_LIST','SCHEDULE_TIMES']) assert.equal((await call(port, `${APP_BASE}/api/v1/system/config`, { method:'PUT', headers:authenticated, body:JSON.stringify({ config_version:'fixture', reload_now:true, items:[{key,value:'false'}] }) })).status, 400);
      assert.equal((await call(port, `${APP_BASE}/api/v1/system/config`, { method:'PUT', headers:authenticated, body:JSON.stringify({ config_version:'fixture', reload_now:true, items:[{key:'SCHEDULE_TIME',value:'25:00'}] }) })).status, 400);
      assert.equal((await call(port, `${APP_BASE}/api/v1/portfolio/accounts`, { method:'POST', headers:authenticated, body:'{"name":"fixture","api_key":"forbidden"}' })).status, 400);
      for (const path of ['/portfolio/accounts/1/broker','/portfolio/positions/QQQ/analysis','/portfolio/import/commit','/system/config/import']) assert.equal((await call(port, `${APP_BASE}/api/v1${path}`, { method:'POST', headers:authenticated, body:'{}' })).status, 403);
    });
    await t.test('mandatory DSA auth, bounded scoped cookie and header isolation', async () => {
      assert.equal((await call(port, `${APP_BASE}/api/v1/history`)).status, 401); authEnabled = false; assert.equal((await call(port, `${APP_BASE}/api/v1/auth/status`)).status, 503); authEnabled = true;
      const login = await call(port, `${APP_BASE}/api/v1/auth/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{"password":"fixture-only"}' });
      assert.equal(login.status, 200); assert.match(login.headers['set-cookie'], /Path=\/plugins\/dsa-workbench\/app\/; HttpOnly; Secure; SameSite=Lax/); assert.doesNotMatch(login.headers['set-cookie'], /gateway_cookie/);
      const result = await call(port, `${APP_BASE}/api/v1/history`, { headers: { ...authenticated, cookie: 'other=ignore; dsa_session=fixture-session; gateway_auth=ignore', authorization: 'Bearer synthetic-do-not-forward' } });
      assert.equal(result.status, 200); const forwarded = seen.at(-1).headers; assert.equal(forwarded.cookie, 'dsa_session=fixture-session'); assert.equal(forwarded.origin, origin); assert.equal(forwarded.host, `127.0.0.1:${targetPort}`);
      for (const name of ['authorization', 'cf-access-jwt-assertion', 'x-forwarded-for', 'x-forwarded-proto']) assert.equal(forwarded[name], undefined);
      assert.equal(result.headers['access-control-allow-origin'], undefined); assert.equal(result.headers.authorization, undefined); assert.equal((await call(port, `${APP_BASE}/api/v1/history`, { headers: { cookie: 'dsa_session=one; dsa_session=two' } })).status, 400);
    });
    await t.test('exact Origin, body/media/size/notify restrictions including auth', async () => {
      for (const badOrigin of [undefined, 'null', 'https://other.invalid', origin + '/']) { const headers = { ...authenticated }; if (badOrigin === undefined) delete headers.origin; else headers.origin = badOrigin; assert.equal((await call(port, `${APP_BASE}/api/v1/stocks/watchlist/add`, { method: 'POST', headers, body: '{"stock_code":"NVDA"}' })).status, 403); }
      assert.equal((await call(port, `${APP_BASE}/api/v1/history`, { headers: { ...authenticated, origin: 'null' } })).status, 403);
      assert.equal((await call(port, `${APP_BASE}/api/v1/analysis/analyze`, { method: 'POST', headers: authenticated, body: '{"stock_code":"NVDA","notify":true}' })).status, 403);
      assert.equal((await call(port, `${APP_BASE}/api/v1/analysis/analyze`, { method: 'POST', headers: authenticated, body: '{"stock_codes":["NVDA","AAPL"]}' })).status, 400);
      assert.equal((await call(port, `${APP_BASE}/api/v1/stocks/watchlist/add`, { method: 'POST', headers: { ...authenticated, 'content-type': 'text/plain' }, body: 'NVDA' })).status, 415);
      assert.equal((await call(port, `${APP_BASE}/api/v1/stocks/watchlist/add`, { method: 'POST', headers: authenticated, body: 'x'.repeat(65537) })).status, 413);
      assert.equal((await call(port, `${APP_BASE}/api/v1/stocks/watchlist/add`, { method: 'POST', headers: { ...authenticated, 'content-encoding': 'gzip' }, body: '{}' })).status, 400);
      const ok = await call(port, `${APP_BASE}/api/v1/analysis/analyze`, { method: 'POST', headers: authenticated, body: '{"stock_code":"NVDA","async_mode":true}' }); assert.equal(ok.status, 200); assert.equal(JSON.parse(seen.at(-1).body).notify, false);
    });
    await t.test('external redirects are rejected, known same-app path rewritten, never followed', async () => {
      scenario = 'external'; assert.equal((await call(port, `${APP_BASE}/api/v1/history`, { headers: authenticated })).status, 502); scenario = 'known'; const known = await call(port, `${APP_BASE}/api/v1/history`, { headers: authenticated }); assert.equal(known.status, 303); assert.equal(known.headers.location, `${APP_BASE}/login`); scenario = '';
    });
    await t.test('SSE is unbuffered and disconnect releases upstream', async () => {
      const released = new Promise(r => { sseClosed = r; }); const started = Date.now(); let firstMs;
      const stream = await new Promise((resolve, reject) => { const req = request({ agent: new Agent({ keepAlive: false }), hostname: '127.0.0.1', port, path: `${APP_BASE}/api/v1/analysis/tasks/stream`, headers: authenticated }, res => { let text = ''; res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text })); res.on('data', chunk => { firstMs ??= Date.now() - started; text += chunk; if (text.includes('heartbeat')) { res.destroy(); resolve({ status: res.statusCode, headers: res.headers, text }); } }); }); req.on('error', reject); req.end(); });
      assert.equal(stream.status, 200); assert.equal(stream.headers['x-accel-buffering'], 'no'); assert.match(stream.text, /connected/); assert.match(stream.text, /heartbeat/); assert.ok(firstMs < 75);
      await Promise.race([released, new Promise((_, reject) => setTimeout(() => reject(new Error('SSE target not released')), 1000))]);
    });
  } finally { await close(app); await close(backend); rmSync(root, { recursive: true }); }
});

test('cookie/redirect transformation strips unrelated credentials and external destinations', () => {
  assert.deepEqual(rewrittenCookies(['other=value; Path=/']), []); assert.match(rewrittenCookies(['dsa_session=; Max-Age=0; Domain=other.invalid; Path=/'])[0], /Path=\/plugins\/dsa-workbench\/app\/; HttpOnly; Secure; SameSite=Lax; Max-Age=0/); assert.throws(() => rewrittenCookies(['dsa_session=one', 'dsa_session=two']));
  for (const location of ['//other.invalid/login', 'https://other.invalid/login', '/api/v1/system/config']) assert.throws(() => rewrittenLocation(location, 'https://dsa.example.invalid'));
  assert.equal(rewrittenLocation('/login?redirect=%2F', 'https://dsa.example.invalid'), `${APP_BASE}/login?redirect=%2Fplugins%2Fdsa-workbench%2Fapp%2F`);
});
