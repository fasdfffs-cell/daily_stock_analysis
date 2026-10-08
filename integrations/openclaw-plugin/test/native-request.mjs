// An actual loopback TCP/HTTP ingress fixture, not an egress proxy or a live Access token.
import { connect } from 'node:net';
export function nativeRequest({ port, path = '/', method = 'GET', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }); const chunks = [];
    const all = { host: `127.0.0.1:${port}`, connection: 'close', ...headers };
    if ((body !== '' || method === 'POST') && !Object.hasOwn(all, 'content-length')) all['content-length'] = Buffer.byteLength(body);
    const lines = [`${method} ${path} HTTP/1.1`];
    for (const [name, values] of Object.entries(all)) for (const value of Array.isArray(values) ? values : [values]) lines.push(`${name}: ${value}`);
    socket.setTimeout(5000, () => socket.destroy(new Error('Loopback test HTTP deadline')));
    socket.on('connect', () => socket.write(`${lines.join('\r\n')}\r\n\r\n${body}`));
    socket.on('data', chunk => chunks.push(chunk)); socket.on('error', reject);
    socket.on('end', () => {
      const text = Buffer.concat(chunks).toString(); const split = text.indexOf('\r\n\r\n');
      const head = text.slice(0, split).split('\r\n'); const responseHeaders = {};
      for (const line of head.slice(1)) { const i = line.indexOf(':'); responseHeaders[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim(); }
      resolve({ status: Number(head[0]?.split(' ')[1]), headers: responseHeaders, text: text.slice(split + 4), body: text.slice(split + 4) });
    });
  });
}
