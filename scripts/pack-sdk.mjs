import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const destination = resolve(root, 'artifacts/npm');
await mkdir(destination, { recursive: true });
for (const name of ['core', 'client', 'dom', 'server']) {
  const result = JSON.parse(execFileSync('npm', ['pack', '--json', '--cache', resolve(root, 'artifacts/.npm-cache'), '--pack-destination', destination], { cwd: resolve(root, 'packages', name), encoding: 'utf8' }));
  process.stdout.write(`${result[0].name}: ${resolve(destination, result[0].filename)}\n`);
}
