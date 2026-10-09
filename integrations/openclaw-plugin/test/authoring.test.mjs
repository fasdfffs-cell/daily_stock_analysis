import assert from 'node:assert/strict';
import test from 'node:test';
import { register, syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import sqlite from 'node:sqlite';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { nativeRequest } from './native-request.mjs';

register('../scripts/sdk-loader.mjs', import.meta.url);
const module = await import(process.env.DSA_ARTIFACT_ENTRY ? pathToFileURL(resolve(process.env.DSA_ARTIFACT_ENTRY)).href : '../dist/index.js');
const plugin = module.default;
const { getToolPluginMetadata } = await import('openclaw/plugin-sdk/tool-plugin');
const metadata = getToolPluginMetadata(plugin);
const admin = { dbPath: resolve('fixture-do-not-create.db'), staticDir: resolve('app') };
function registration(config = admin, runtimeConfig, messages = []) {
  const descriptors = [], routes = [];
  const unexpected = () => { throw new Error('No additional capabilities may be registered'); };
  plugin.register({ id: 'dsa-workbench', pluginConfig: config, config: runtimeConfig, logger: { warn(value) { messages.push(value); } },
    session: { controls: { registerControlUiDescriptor(value) { descriptors.push(value); } } },
    registerHttpRoute(value) { routes.push(value); }, registerTool: unexpected,
    registerSessionAction: unexpected, registerCommand: unexpected, registerService: unexpected,
    registerGatewayMethod: unexpected,
  });
  return { descriptors, routes };
}

test('public authoring factory retains strict complete metadata without invented tools', () => {
  assert.equal(metadata.id, 'dsa-workbench'); assert.deepEqual(metadata.tools, []);
  assert.equal(metadata.configSchema.additionalProperties, false);
  assert.equal(metadata.configSchema.required, undefined);
  assert.deepEqual(Object.keys(metadata.configSchema.properties).sort(), ['dbPath', 'staticDir', 'tailscaleBin', 'tailscaleLogin', 'cloudflareAccessHost', 'cloudflareAccessIssuer', 'cloudflareAccessAudience', 'cloudflareAccessEmail', 'accessPolicySource'].sort());
  const manifest = JSON.parse(readFileSync('openclaw.plugin.json', 'utf8'));
  assert.deepEqual(metadata.configSchema, manifest.configSchema);
  assert.deepEqual(manifest.contracts.tools, []); assert.equal(manifest.controlUi, undefined);
});

test('actual host SDK composition registers only the original descriptor and guarded route', () => {
  const { descriptors, routes } = registration();
  assert.deepEqual(descriptors, [{ surface: 'tab', id: 'dsa-workbench', label: '股票研究', description: '原 DSA 报告与私人研究工作台 · 原生定时', icon: 'chart-line', group: 'agent', order: 40, path: '/plugins/dsa-workbench/', requiredScopes: ['operator.read'] }]);
  assert.equal(routes.length, 1); assert.equal(routes[0].path, '/plugins/dsa-workbench/');
  assert.equal(routes[0].match, 'prefix'); assert.equal(routes[0].auth, 'plugin');
});

test('strict optional installation schema accepts empty config without weakening business parser', () => {
  assert.equal(plugin.configSchema.safeParse(admin).success, true);
  assert.equal(plugin.configSchema.safeParse({}).success, true);
  for (const value of [{ dbPath: admin.dbPath }, { staticDir: admin.staticDir }, { ...admin, dbPath: 'relative.db' }, { ...admin, staticDir: 'relative' }, { ...admin, dbPath: '/bad\0path' }]) assert.equal(plugin.configSchema.safeParse(value).success, false);
  for (const value of [{ ...admin, extra: true }, { ...admin, staticDir: 1 }, { ...admin, dbPath: '' }]) assert.equal(plugin.configSchema.safeParse(value).success, false);
  for (const value of [{}, { dbPath: admin.dbPath }, { ...admin, staticDir: 'relative' }, { ...admin, dbPath: 'relative.db' }, { ...admin, extra: 'not-allowed' }, { ...admin, cloudflareAccessHost: 'dsa.example.invalid' }, { ...admin, cloudflareAccessEmail: 'owner@example.invalid' }]) assert.doesNotThrow(() => registration(value));
  registration({ ...admin, cloudflareAccessHost: 'dsa.example.invalid', cloudflareAccessIssuer: 'https://fixture.cloudflareaccess.com', cloudflareAccessAudience: 'fixture' });
});

test('empty, incomplete and invalid initial configs stay guarded 503 with no local business or acquisition', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsa-inert-'));
  const missingDatabase = join(root, 'must-not-create.db');
  const values = [undefined, {}, { dbPath: missingDatabase }, { staticDir: '/must-not-read-static' }, { cloudflareAccessHost: 'dsa.example.invalid', cloudflareAccessIssuer: 'https://fixture.cloudflareaccess.com', cloudflareAccessAudience: 'fixture' }, { tailscaleLogin: 'fixture@example.invalid' }, { ...admin, staticDir: 'relative' }, { ...admin, cloudflareAccessHost: 'dsa.example.invalid' }, { ...admin, cloudflareAccessEmail: 'owner@example.invalid' }, { ...admin, extra: 'do-not-trust' }];
  const originalFetch = globalThis.fetch;
  const originals = [[http, 'Agent'], [http, 'request'], [sqlite, 'DatabaseSync'], [fs, 'lstatSync'], [fs, 'openSync'], [childProcess, 'execFile']].map(([object, key]) => [object, key, object[key]]);
  let sideEffects = 0;
  const blocked = function () { sideEffects++; throw new Error('Inactive plugin must not initialize DB/agent/filesystem/network/WhoIs'); };
  for (const [object, key] of originals) object[key] = blocked;
  syncBuiltinESMExports();
  globalThis.fetch = blocked;
  try {
    for (const value of values) {
      const { routes } = registration(value === undefined ? {} : value);
      const server = createServer(routes[0].handler);
      try {
        await new Promise(done => server.listen(0, '127.0.0.1', done)); const port = server.address().port;
        for (const path of ['/plugins/dsa-workbench/', '/plugins/dsa-workbench/overview.css', '/plugins/dsa-workbench/app/', '/plugins/dsa-workbench/app/api/v1/auth/status', '/plugins/dsa-workbench/app/api/v1/history']) {
          const result = await nativeRequest({ port, path });
          assert.equal(result.status, 503); assert.equal(JSON.parse(result.text).error, 'dsa_workbench_not_configured');
          assert.doesNotMatch(result.text, /NVDA|saved-report|must-not-read-static|fixture-do-not-create|<script|<form/);
        }
        const head = await nativeRequest({ port, path: '/plugins/dsa-workbench/', method: 'HEAD' });
        assert.equal(head.status, 503); assert.equal(head.text, '');
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
          const denied = await nativeRequest({ port, path: '/plugins/dsa-workbench/app/api/v1/analysis/analyze?echo=private-canary', method, headers: { origin: 'https://untrusted.invalid', cookie: 'canary=private-canary' } });
          assert.equal(denied.status, 503); assert.deepEqual(JSON.parse(denied.text), { error: 'dsa_workbench_not_configured', message: 'DSA Workbench is not configured; all business access is disabled.' });
          for (const name of ['set-cookie', 'access-control-allow-origin', 'access-control-allow-credentials', 'location']) assert.equal(denied.headers[name], undefined);
          assert.equal(denied.headers['cache-control'], 'no-store'); assert.doesNotMatch(denied.text, /private-canary/);
        }
        const write = await nativeRequest({ port, path: '/plugins/dsa-workbench/app/api/v1/auth/login', method: 'POST', body: '{"password":"fixture-only"}' });
        assert.equal(write.status, 503); assert.equal(write.headers['set-cookie'], undefined);
        for (const headers of [{ host: 'unknown.invalid' }, { host: '127.0.0.1', 'x-forwarded-for': '203.0.113.1' }, { host: 'dsa.example.invalid', 'x-forwarded-proto': 'https', 'cf-access-jwt-assertion': 'not-a-real-token' }]) assert.equal((await nativeRequest({ port, path: '/plugins/dsa-workbench/', headers })).status, 503);
        assert.equal(existsSync(missingDatabase), false);
        assert.equal(sideEffects, 0);
      } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    }
  } finally { for (const [object, key, original] of originals) object[key] = original; syncBuiltinESMExports(); globalThis.fetch = originalFetch; rmSync(root, { recursive: true }); }
});

test('explicit source schema has no auto-filled direct metadata and rejects every source conflict', () => {
  for (const accessPolicySource of ['todo', 'parking-trends']) {
    const input = { ...admin, accessPolicySource };
    const parsed = plugin.configSchema.safeParse(input);
    assert.equal(parsed.success, true); assert.deepEqual(parsed.data, input);
    for (const key of ['tailscaleBin', 'tailscaleLogin', 'cloudflareAccessHost', 'cloudflareAccessIssuer', 'cloudflareAccessAudience', 'cloudflareAccessEmail']) assert.equal(plugin.configSchema.safeParse({ ...input, [key]: '' }).success, false, key);
  }
  assert.equal(plugin.configSchema.safeParse({ ...admin, accessPolicySource: '../arbitrary' }).success, false);
  assert.equal(plugin.configSchema.safeParse({ accessPolicySource: 'todo' }).success, true);
});

test('absent disabled redacted incomplete and invalid source metadata stays inert without exposure or acquisition', async () => {
  const fields = { tailscaleBin: '/usr/bin/tailscale', tailscaleLogin: '', cloudflareAccessHost: 'source.example.invalid', cloudflareAccessIssuer: 'https://source-fixture.cloudflareaccess.com', cloudflareAccessAudience: 'private-fixture-aud', cloudflareAccessEmail: '' };
  const entry = config => ({ plugins: { entries: { todo: { enabled: true, config } } } });
  const missing = { ...fields }; delete missing.cloudflareAccessAudience;
  const snapshots = [undefined, {}, { plugins: { entries: {} } }, { plugins: { entries: { todo: { enabled: false, config: fields } } } }, entry(missing), entry({ ...fields, cloudflareAccessAudience: '<redacted>' }), entry({ ...fields, cloudflareAccessAudience: 'x'.repeat(2049) }), entry({ ...fields, cloudflareAccessAudience: 42 }), entry({ ...fields, cloudflareAccessAudience: '' }), entry({ ...fields, tailscaleBin: 'relative' }), entry({ ...fields, tailscaleLogin: 'fixture@example.invalid', cloudflareAccessAudience: '' }), entry({ ...fields, cloudflareAccessHost: '', cloudflareAccessIssuer: '', cloudflareAccessAudience: '' }), ...Object.keys(fields).map(key => entry({ ...fields, [key]: '<redacted>' }))];
  const oldFetch = globalThis.fetch; const oldAgent = http.Agent; let effects = 0;
  const blocked = function () { effects++; throw new Error('Invalid source may not acquire or initialize proxy'); };
  http.Agent = blocked; syncBuiltinESMExports(); globalThis.fetch = blocked;
  try {
    for (const snapshot of snapshots) {
      const messages = []; const { routes, descriptors } = registration({ ...admin, accessPolicySource: 'todo' }, snapshot, messages);
      const server = createServer(routes[0].handler);
      try {
        await new Promise(done => server.listen(0, '127.0.0.1', done));
        const result = await nativeRequest({ port: server.address().port, path: '/plugins/dsa-workbench/app/api/v1/auth/status' });
        assert.equal(result.status, 503); assert.equal(JSON.parse(result.text).error, 'dsa_workbench_not_configured');
        assert.doesNotMatch(result.text + JSON.stringify(messages) + JSON.stringify(descriptors), /private-fixture-aud|source\.example|source-fixture|<redacted>/);
        assert.equal(effects, 0);
      } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    }
    const noRead = { get plugins() { throw new Error('Paths/selector must precede snapshot read'); } };
    assert.doesNotThrow(() => registration({}, noRead));
    assert.doesNotThrow(() => registration({ accessPolicySource: 'todo' }, noRead));
    assert.doesNotThrow(() => registration({ ...admin, accessPolicySource: 'todo', tailscaleLogin: 'conflict' }, noRead));
    assert.doesNotThrow(() => registration({ ...admin, accessPolicySource: 'unknown' }, noRead));
  } finally { http.Agent = oldAgent; syncBuiltinESMExports(); globalThis.fetch = oldFetch; }
});

test('single-backend embedded catalog preserves every original app resource byte', () => {
  const files = [];
  function walk(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(directory, entry.name), prefix + entry.name + '/');
      else files.push(prefix + entry.name);
    }
  }
  walk('app'); assert.deepEqual(Object.keys(module.BUNDLED_APP_ASSETS).sort(), files.sort());
  for (const file of files) {
    const bytes = readFileSync(join('app', file));
    assert.deepEqual(Buffer.from(module.BUNDLED_APP_ASSETS[file], 'base64'), bytes, file);
    assert.equal(module.BUNDLED_APP_ASSET_HASHES[file], createHash('sha256').update(bytes).digest('hex'), file);
  }
  for (const file of ['index.html', 'stocks.index.json']) assert.ok(module.BUNDLED_APP_ASSETS[file]);
  assert.ok(files.some(name => /^assets\/.*\.css$/.test(name)));
  assert.ok(files.some(name => /^assets\/.*\.js$/.test(name)));
});

test('registered entry retains escaped readonly reports, exact CSS and full RS256 identity guard on all routes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsa-authoring-'));
  const dbPath = join(root, 'reports.db'); const database = new DatabaseSync(dbPath);
  database.exec('CREATE TABLE analysis_history(id INTEGER PRIMARY KEY, code TEXT, name TEXT, created_at TEXT, report_type TEXT, analysis_summary TEXT, raw_result TEXT, context_snapshot TEXT)');
  database.prepare('INSERT INTO analysis_history VALUES(?,?,?,?,?,?,?,?)').run(2, 'NVDA', 'DEMO', '2026-10-08 00:00:00', 'detailed', '<b>escaped</b>', JSON.stringify({ model_used: 'DEMO/offline-fixture', market_snapshot: { date: '2026-10-07' } }), '{}'); database.close();
  const before = readFileSync(dbPath);
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const issuer = 'https://artifact-fixture.cloudflareaccess.com', host = 'dsa.example.invalid';
  const config = { dbPath, staticDir: resolve('app'), cloudflareAccessHost: host, cloudflareAccessIssuer: issuer, cloudflareAccessAudience: 'artifact-fixture' };
  const headers = { host, 'x-forwarded-proto': 'https' };
  function token(extra = {}) {
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ iss: issuer, aud: 'artifact-fixture', email: 'owner@example.invalid', exp: Math.floor(Date.now() / 1000) + 600, ...extra })).toString('base64url');
    return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(String(url), `${issuer}/cdn-cgi/access/certs`);
    return new Response(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' }] }));
  };
  const { routes } = registration(config); const server = createServer(routes[0].handler);
  try {
    await new Promise(done => server.listen(0, '127.0.0.1', done)); const port = server.address().port;
    const call = (path, options = {}) => nativeRequest({ port, path, ...options });
    const paths = ['/plugins/dsa-workbench/', '/plugins/dsa-workbench/overview.css', '/plugins/dsa-workbench/app/', '/plugins/dsa-workbench/app/assets/' + Object.keys(module.BUNDLED_APP_ASSETS).find(name => name.startsWith('assets/') && name.endsWith('.js')).slice(7), '/plugins/dsa-workbench/app/api/v1/not-enabled'];
    for (const path of paths) assert.equal((await call(path, { headers })).status, 401, path);
    const authenticated = { ...headers, 'cf-access-jwt-assertion': token() };
    for (const path of paths.slice(0, 4)) assert.equal((await call(path, { headers: authenticated })).status, 200, path);
    assert.equal((await call(paths[4], { headers: authenticated })).status, 403);
    const overview = await call(paths[0], { headers: authenticated });
    assert.match(overview.text, /&lt;b&gt;escaped&lt;\/b&gt;/); assert.match(overview.text, /NVDA/); assert.match(overview.text, /DEMO\/offline-fixture/); assert.match(overview.text, /2026-10-07/); assert.match(overview.text, /saved-report/); assert.doesNotMatch(overview.text, /<script|<form|fetch\(|postMessage/);
    assert.equal((await call(paths[0], { method: 'POST', headers: authenticated })).status, 405);
    assert.equal((await call(paths[1], { headers: authenticated })).text, readFileSync('static/overview.css', 'utf8'));
    for (const extra of [{ email: '' }, { email: null }, { iss: 'https://wrong.cloudflareaccess.com' }, { aud: 'wrong' }, { exp: 1 }, { nbf: Math.floor(Date.now() / 1000) + 600 }]) assert.equal((await call(paths[0], { headers: { ...headers, 'cf-access-jwt-assertion': token(extra) } })).status, 401);
    assert.equal((await call(paths[0], { headers: { ...headers, 'cf-access-jwt-assertion': token().slice(0, -12) + 'invalidbytes' } })).status, 401);
    for (const spoof of [{ host: 'untrusted.invalid' }, { host: '127.0.0.1', 'x-forwarded-for': '203.0.113.1' }]) assert.equal((await call(paths[0], { headers: spoof })).status, 401);
    for (const source of ['todo', 'parking-trends']) {
      const readFields = [], messages = [];
      const values = { tailscaleBin: '/usr/bin/tailscale', tailscaleLogin: '', cloudflareAccessHost: host, cloudflareAccessIssuer: issuer, cloudflareAccessAudience: 'artifact-fixture', cloudflareAccessEmail: source === 'parking-trends' ? 'owner@example.invalid' : '' };
      const projectedSource = {};
      for (const [key, value] of Object.entries(values)) Object.defineProperty(projectedSource, key, { enumerable: true, get() { readFields.push(key); return value; } });
      for (const key of ['dbPath', 'staticDir', 'password', 'provider', 'secret']) Object.defineProperty(projectedSource, key, { enumerable: true, get() { throw new Error('Only six policy metadata fields may be read'); } });
      const entries = { [source]: { enabled: true, config: projectedSource } };
      Object.defineProperty(entries, source === 'todo' ? 'parking-trends' : 'todo', { get() { throw new Error('Unselected source may not be read'); } });
      const snapshot = { plugins: { entries }, get models() { throw new Error('Provider configuration may not be read'); } };
      const inherited = registration({ dbPath, staticDir: resolve('app'), accessPolicySource: source }, snapshot, messages);
      assert.deepEqual(readFields.sort(), Object.keys(values).sort());
      const sourced = createServer(inherited.routes[0].handler);
      try {
        await new Promise(done => sourced.listen(0, '127.0.0.1', done)); const sourcePort = sourced.address().port;
        for (const path of paths) assert.equal((await nativeRequest({ port: sourcePort, path, headers })).status, 401);
        for (const path of paths.slice(0, 4)) {
          const response = await nativeRequest({ port: sourcePort, path, headers: authenticated });
          assert.equal(response.status, 200); assert.doesNotMatch(response.text, /artifact-fixture|owner@example\.invalid/);
        }
        assert.equal((await nativeRequest({ port: sourcePort, path: paths[4], headers: authenticated })).status, 403);
        if (source === 'parking-trends') assert.equal((await nativeRequest({ port: sourcePort, path: paths[0], headers: { ...headers, 'cf-access-jwt-assertion': token({ email: 'different@example.invalid' }) } })).status, 401);
        for (const extra of [{ email: '' }, { email: null }, { email: 'x'.repeat(321) }, { iss: 'https://wrong.cloudflareaccess.com' }, { aud: 'wrong' }, { exp: 1 }, { nbf: Math.floor(Date.now() / 1000) + 600 }]) assert.equal((await nativeRequest({ port: sourcePort, path: paths[0], headers: { ...headers, 'cf-access-jwt-assertion': token(extra) } })).status, 401);
        assert.equal((await nativeRequest({ port: sourcePort, path: paths[0], headers: { ...headers, 'cf-access-jwt-assertion': token().slice(0, -12) + 'invalidbytes' } })).status, 401);
        assert.doesNotMatch(JSON.stringify(messages) + JSON.stringify(inherited.descriptors), /artifact-fixture|owner@example\.invalid/);
      } finally { sourced.closeAllConnections(); await new Promise(done => sourced.close(done)); }
    }
    // A complete valid identity does not make missing business paths usable.
    const partial = { ...config }; delete partial.staticDir;
    const inactive = createServer(registration(partial).routes[0].handler);
    try {
      await new Promise(done => inactive.listen(0, '127.0.0.1', done));
      const inactivePort = inactive.address().port;
      assert.equal((await nativeRequest({ port: inactivePort, path: paths[0], headers })).status, 503);
      for (const path of paths) {
        const result = await nativeRequest({ port: inactivePort, path, headers: authenticated });
        assert.equal(result.status, 503); assert.equal(JSON.parse(result.text).error, 'dsa_workbench_not_configured');
      }
    } finally { inactive.closeAllConnections(); await new Promise(done => inactive.close(done)); }
    // Complete paths without remote identity preserve the existing local-trust policy.
    const local = createServer(registration({ dbPath, staticDir: resolve('app') }).routes[0].handler);
    try {
      await new Promise(done => local.listen(0, '127.0.0.1', done));
      const localPort = local.address().port;
      assert.equal((await nativeRequest({ port: localPort, path: paths[0] })).status, 200);
      assert.equal((await nativeRequest({ port: localPort, path: paths[1] })).status, 200);
      assert.equal((await nativeRequest({ port: localPort, path: paths[0], headers: { host: 'untrusted.invalid' } })).status, 401);
    } finally { local.closeAllConnections(); await new Promise(done => local.close(done)); }
    assert.deepEqual(readFileSync(dbPath), before);
  } finally {
    globalThis.fetch = originalFetch; server.closeAllConnections();
    if (server.listening) await new Promise(done => server.close(done));
    rmSync(root, { recursive: true });
  }
});
