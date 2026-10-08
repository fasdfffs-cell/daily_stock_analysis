// Disposable loopback-only native HTTP fixture, never installed in the Gateway.
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { parseConfig } from '../dist/config.js';
import { withDsaRouteAccess } from '../dist/access.js';
import { createDsaHttpHandler } from '../dist/http.js';
const port = Number(process.argv[2]), upstreamPort = Number(process.argv[3]);
if (![port, upstreamPort].every(n => Number.isInteger(n) && n >= 1024 && n <= 65535 && n !== 8010 && n !== 18789)) throw new Error('Explicit disposable fixture ports required');
const config = parseConfig({ dbPath: resolve(process.argv[4]), staticDir: resolve('../../static-gateway') });
const handler = withDsaRouteAccess(createDsaHttpHandler(config, { upstreamPort }), config);
const server = createServer(async (req, res) => {
  if (req.url === '/fixture-host') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html><title>LOCAL FIXTURE</title><iframe title="股票研究 fixture" sandbox="allow-scripts" src="/plugins/dsa-workbench/" style="width:100%;height:900px"></iframe></html>');
  } else await handler(req, res);
});
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ fixture: true, port, upstreamPort, pid: process.pid, liveGatewayLoaded: false })));
function stop() { server.closeAllConnections(); server.close(() => process.exit(0)); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
