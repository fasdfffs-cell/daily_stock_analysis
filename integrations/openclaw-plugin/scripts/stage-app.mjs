import { cpSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../../../static-gateway/', import.meta.url));
const target = fileURLToPath(new URL('../app/', import.meta.url));
if (!existsSync(source) || !readFileSync(source + 'index.html', 'utf8').includes('/plugins/dsa-workbench/app/assets/')) throw new Error('Build the prefixed original React bundle first');
cpSync(source, target, { recursive: true, dereference: false, errorOnExist: true, force: false });
console.log(JSON.stringify({ staged: true, originalReact: true, source: 'static-gateway/', target: 'app/' }));
