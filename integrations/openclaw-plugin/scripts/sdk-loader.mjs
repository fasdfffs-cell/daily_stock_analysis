import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const host = process.env.OPENCLAW_PACKAGE_ROOT || join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'openclaw');
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'openclaw/plugin-sdk/plugin-entry') return { url: pathToFileURL(join(host, 'dist/plugin-sdk/plugin-entry.js')).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
