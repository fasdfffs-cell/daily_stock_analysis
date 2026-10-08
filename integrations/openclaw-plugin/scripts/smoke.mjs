import assert from 'node:assert/strict';
import { register } from 'node:module';
import { resolve } from 'node:path';
register('./sdk-loader.mjs', import.meta.url);
const plugin = (await import('../dist/index.js')).default;
const descriptors = [], routes = [];
plugin.register({ pluginConfig: { dbPath: resolve('fixture-do-not-create.db') }, logger: { warn() {} },
  session: { controls: { registerControlUiDescriptor(v) { descriptors.push(v); } } },
  registerHttpRoute(v) { routes.push(v); },
});
assert.equal(descriptors.length, 1); assert.equal(routes.length, 1);
assert.equal(descriptors[0].surface, 'tab'); assert.equal(descriptors[0].id, 'dsa-workbench');
assert.equal(descriptors[0].label, '股票研究'); assert.equal(descriptors[0].group, 'agent');
assert.equal(descriptors[0].order, 40); assert.equal(descriptors[0].path, '/plugins/dsa-workbench/');
assert.deepEqual(descriptors[0].requiredScopes, ['operator.read']);
assert.equal(routes[0].auth, 'plugin'); assert.equal(routes[0].match, 'prefix');
assert.equal(routes[0].path, '/plugins/dsa-workbench/');
console.log(JSON.stringify({ ok: true, actualHostSdk: true, descriptors, route: { path: routes[0].path, match: routes[0].match, auth: routes[0].auth }, liveGatewayLoaded: false }, null, 2));
