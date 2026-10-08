// Use the installed host SDK and its TypeScript compiler, not absolute workspace imports.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const host = process.env.OPENCLAW_PACKAGE_ROOT || join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'openclaw');
const compiler = join(host, 'node_modules/typescript/bin/tsc');
const sdk = join(host, 'dist/plugin-sdk/plugin-entry.d.ts');
if (!existsSync(compiler) || !existsSync(sdk)) throw new Error('An installed OpenClaw 2026.9.4+ SDK and TypeScript compiler are required; set OPENCLAW_PACKAGE_ROOT for a non-global host.');
const config = JSON.parse(readFileSync('tsconfig.json', 'utf8'));
config.extends = './tsconfig.json';
config.compilerOptions.typeRoots = [join(host, 'node_modules/@types')];
config.compilerOptions.types = ['node'];
config.compilerOptions.paths = { 'openclaw/plugin-sdk/plugin-entry': [sdk] };
const generated = '.tsconfig.host.json';
writeFileSync(generated, JSON.stringify(config));
execFileSync(process.execPath, [compiler, '-p', resolve(generated), ...(process.argv.includes('--check') ? ['--noEmit'] : [])], { stdio: 'inherit' });
