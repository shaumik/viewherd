import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ASSET_FILES } from '../src/assets.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const modules = new Map();
const declarations = [];
const localPackages = { '@viewherd/core': 'packages/core/index.mjs', '@viewherd/server': 'packages/server/index.mjs', '@viewherd/client': 'packages/client/index.mjs' };

// A dependency-free module linker preserves module scopes in the Worker artifact.
async function linkModule(path) {
  path = resolve(path);
  if (modules.has(path)) return modules.get(path);
  const key = `__webdrModule${modules.size}`;
  modules.set(path, key);
  let code = await readFile(path, 'utf8');
  const exports = [];
  const importPattern = /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?\s*$/gm;
  for (const match of [...code.matchAll(importPattern)]) {
    const specifier = match[2];
    const dependencyPath = specifier.startsWith('.') ? resolve(dirname(path), specifier) : localPackages[specifier] && resolve(root, localPackages[specifier]);
    if (!dependencyPath) throw new Error(`Unsupported build import ${specifier} in ${relative(root, path)}`);
    const dependency = await linkModule(dependencyPath);
    const clause = match[1].trim();
    let replacement;
    if (clause.startsWith('{')) replacement = `const ${clause.replace(/\b(\w+)\s+as\s+(\w+)\b/g, '$1: $2')} = ${dependency};`;
    else if (clause.startsWith('* as ')) replacement = `const ${clause.slice(5)} = ${dependency};`;
    else replacement = `const ${clause} = ${dependency}.default;`;
    code = code.replace(match[0], replacement);
  }
  const reexportPattern = /^export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?\s*$/gm;
  for (const match of [...code.matchAll(reexportPattern)]) {
    const dependency = await linkModule(resolve(dirname(path), match[2]));
    const entries = match[1].split(',').map(item => item.trim()).filter(Boolean);
    const locals = entries.map(entry => entry.split(/\s+as\s+/)[0]);
    code = code.replace(match[0], `const {${locals.join(',')}} = ${dependency};`);
    for (const entry of entries) { const [local, alias = local] = entry.split(/\s+as\s+/); exports.push(`${JSON.stringify(alias)}:${local}`); }
  }
  code = code.replace(/^export\s+(async\s+)?(function|class)\s+(\w+)/gm, (_, asyncPrefix = '', kind, name) => { exports.push(`${name}:${name}`); return `${asyncPrefix}${kind} ${name}`; });
  code = code.replace(/^export\s+(const|let|var)\s+(\w+)/gm, (_, kind, name) => { exports.push(`${name}:${name}`); return `${kind} ${name}`; });
  code = code.replace(/^export\s*\{([^}]+)\};?\s*$/gm, (_, list) => {
    for (const entry of list.split(',').map(item => item.trim()).filter(Boolean)) { const [local, alias = local] = entry.split(/\s+as\s+/); exports.push(`${JSON.stringify(alias)}:${local}`); }
    return '';
  });
  code = code.replace(/^export default /gm, () => { exports.push('default:__webdrDefault'); return 'const __webdrDefault = '; });
  if (/^\s*(import|export)\s/m.test(code)) throw new Error(`Unlinked ESM declaration in ${relative(root, path)}`);
  declarations.push(`// ${relative(root, path)}\nconst ${key}=(()=>{\n${code}\nreturn {${exports.join(',')}};\n})();`);
  return key;
}

const assets = {};
const assetEntries = ASSET_FILES;
for (const [path, file, type] of assetEntries) {
  if (type.startsWith('text/javascript')) execFileSync(process.execPath, ['--check', resolve(root, file)], { stdio: 'pipe' });
  let content = await readFile(resolve(root, file), 'utf8');
  if (path === '/lab/index.html') content = content.replaceAll('href="/styles.css"', 'href="/lab/styles.css"').replaceAll('src="/app.js"', 'src="/lab/app.js"').replaceAll('href="/"', 'href="/lab"');
  assets[path] = { content, type };
}
const entry = await linkModule(resolve(root, 'src/worker-entry.mjs'));
const source = `const WEBDR_ASSETS=${JSON.stringify(assets)};\n${declarations.join('\n\n')}\nexport const makeD1Store=${entry}.makeD1Store;\nexport default ${entry}.default;\n`;
await mkdir(resolve(root, 'worker'), { recursive: true });
await writeFile(resolve(root, 'worker/index.js'), source);
await rm(resolve(root, 'dist'), { recursive: true, force: true });
await mkdir(resolve(root, 'dist/server'), { recursive: true });
await mkdir(resolve(root, 'dist/.openai'), { recursive: true });
await writeFile(resolve(root, 'dist/server/index.js'), source);
await cp(resolve(root, '.openai/hosting.json'), resolve(root, 'dist/.openai/hosting.json'));
await cp(resolve(root, 'drizzle'), resolve(root, 'dist/.openai/drizzle'), { recursive: true });
process.stdout.write(`Built Viewherd SDK + Forma Studio Worker (${Math.round(source.length / 1024)} KB)\n`);
