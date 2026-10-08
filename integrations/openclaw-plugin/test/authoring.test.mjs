import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
function registration(config = admin) {
  const descriptors = [], routes = [];
  const unexpected = () => { throw new Error('No additional capabilities may be registered'); };
  plugin.register({ id: 'dsa-workbench', pluginConfig: config, logger: { warn() {} },
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
  assert.deepEqual(metadata.configSchema.required, ['dbPath', 'staticDir']);
  assert.deepEqual(Object.keys(metadata.configSchema.properties).sort(), ['dbPath', 'staticDir', 'tailscaleBin', 'tailscaleLogin', 'cloudflareAccessHost', 'cloudflareAccessIssuer', 'cloudflareAccessAudience', 'cloudflareAccessEmail'].sort());
  const manifest = JSON.parse(readFileSync('openclaw.plugin.json', 'utf8'));
  assert.deepEqual(metadata.configSchema, manifest.configSchema);
  assert.deepEqual(manifest.contracts.tools, []); assert.equal(manifest.controlUi, undefined);
});

test('actual host SDK composition registers only the original descriptor and guarded route', () => {
  const { descriptors, routes } = registration();
  assert.deepEqual(descriptors, [{ surface: 'tab', id: 'dsa-workbench', label: '股票研究', description: '原 DSA 报告概览与完整私人手动工作台', icon: 'chart-line', group: 'agent', order: 40, path: '/plugins/dsa-workbench/', requiredScopes: ['operator.read'] }]);
  assert.equal(routes.length, 1); assert.equal(routes[0].path, '/plugins/dsa-workbench/');
  assert.equal(routes[0].match, 'prefix'); assert.equal(routes[0].auth, 'plugin');
});

test('schema and composed registration reject missing paths, unknown config and incomplete Access', () => {
  assert.equal(plugin.configSchema.safeParse(admin).success, true);
  for (const value of [{}, { dbPath: admin.dbPath }, { ...admin, extra: true }, { ...admin, staticDir: 1 }]) assert.equal(plugin.configSchema.safeParse(value).success, false);
  for (const value of [{}, { dbPath: admin.dbPath }, { ...admin, staticDir: 'relative' }, { ...admin, dbPath: 'relative.db' }, { ...admin, extra: 'not-allowed' }, { ...admin, cloudflareAccessHost: 'dsa.example.invalid' }, { ...admin, cloudflareAccessEmail: 'owner@example.invalid' }]) assert.throws(() => registration(value));
  registration({ ...admin, cloudflareAccessHost: 'dsa.example.invalid', cloudflareAccessIssuer: 'https://fixture.cloudflareaccess.com', cloudflareAccessAudience: 'fixture' });
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
    assert.deepEqual(readFileSync(dbPath), before);
  } finally {
    globalThis.fetch = originalFetch; server.closeAllConnections();
    if (server.listening) await new Promise(done => server.close(done));
    rmSync(root, { recursive: true });
  }
});
