import assert from 'node:assert/strict';
import { register } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
register('./sdk-loader.mjs', import.meta.url);
const plugin = (await import(process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : '../dist/index.js')).default;
const { getToolPluginMetadata } = await import('openclaw/plugin-sdk/tool-plugin');
const metadata = getToolPluginMetadata(plugin);
assert.ok(metadata); assert.deepEqual(metadata.tools, []);
assert.equal(metadata.configSchema.required, undefined);
assert.equal(metadata.configSchema.additionalProperties, false);
assert.equal(Object.keys(metadata.configSchema.properties).length, 9);
assert.equal(plugin.configSchema.safeParse({}).success, true);
for (const value of [{ dbPath: resolve('fixture-do-not-create.db') }, { staticDir: resolve('app') }, { dbPath: 'relative.db', staticDir: resolve('app') }]) assert.equal(plugin.configSchema.safeParse(value).success, false);
assert.equal(plugin.configSchema.safeParse({ dbPath: resolve('fixture-do-not-create.db'), staticDir: resolve('app') }).success, true);
assert.equal(plugin.configSchema.safeParse({ dbPath: resolve('fixture-do-not-create.db'), staticDir: resolve('app'), targetUrl: 'https://other.invalid' }).success, false);
const descriptors = [], routes = [];
const rejectNewCapability = () => { throw new Error('Unexpected new capability registration'); };
plugin.register({ id: 'dsa-workbench', pluginConfig: { dbPath: resolve('fixture-do-not-create.db'), staticDir: resolve('app'), accessPolicySource: 'todo' }, config: { plugins: { entries: { todo: { enabled: true, config: { tailscaleBin: '/usr/bin/tailscale', tailscaleLogin: '', cloudflareAccessHost: 'smoke.example.invalid', cloudflareAccessIssuer: 'https://smoke-fixture.cloudflareaccess.com', cloudflareAccessAudience: 'smoke-fixture-aud', cloudflareAccessEmail: '' } } } } }, logger: { warn() {} },
  session: { controls: { registerControlUiDescriptor(v) { descriptors.push(v); } } },
  registerHttpRoute(v) { routes.push(v); },
  registerTool: rejectNewCapability, registerSessionAction: rejectNewCapability,
  registerCommand: rejectNewCapability, registerService: rejectNewCapability,
  registerGatewayMethod: rejectNewCapability,
});
assert.equal(descriptors.length, 1); assert.equal(routes.length, 1);
assert.equal(descriptors[0].surface, 'tab'); assert.equal(descriptors[0].id, 'dsa-workbench');
assert.equal(descriptors[0].label, '股票研究'); assert.equal(descriptors[0].group, 'agent');
assert.equal(descriptors[0].order, 40); assert.equal(descriptors[0].path, '/plugins/dsa-workbench/');
assert.deepEqual(descriptors[0].requiredScopes, ['operator.read']);
assert.equal(routes[0].auth, 'plugin'); assert.equal(routes[0].match, 'prefix');
assert.equal(routes[0].path, '/plugins/dsa-workbench/');
const { createServer } = await import('node:http');
const { nativeRequest } = await import('../test/native-request.mjs');
const fixtureServer = createServer(routes[0].handler);
try {
  await new Promise(done => fixtureServer.listen(0, '127.0.0.1', done));
  const result = await nativeRequest({ port: fixtureServer.address().port, path: '/plugins/dsa-workbench/', headers: { host: 'smoke.example.invalid', 'x-forwarded-proto': 'https' } });
  assert.equal(result.status, 401); assert.doesNotMatch(result.text, /smoke-fixture-aud/);
} finally { fixtureServer.closeAllConnections(); await new Promise(done => fixtureServer.close(done)); }
console.log(JSON.stringify({ ok: true, actualHostSdk: true, explicitSyntheticSourceConfiguredGuard401: true, authoringMetadata: { id: metadata.id, tools: metadata.tools, configSchema: metadata.configSchema }, descriptors, route: { path: routes[0].path, match: routes[0].match, auth: routes[0].auth }, newCapabilitiesRegistered: 0, liveGatewayLoaded: false }, null, 2));
