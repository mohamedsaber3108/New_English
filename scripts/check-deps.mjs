// Fails if any source file imports a package that package.json does not declare.
// Guards against "works on my machine" installs (a package present in node_modules but missing from the manifest).
import {readFile, readdir} from 'node:fs/promises';
import {join, extname} from 'node:path';
import {builtinModules} from 'node:module';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const declared = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
const builtins = new Set(builtinModules.flatMap(m => [m, 'node:' + m]));
const roots = ['server', 'scripts', 'tests', 'client/src', 'vite.config.js'];
const files = [];
async function walk(p) {
  let entries;
  try { entries = await readdir(p, {withFileTypes: true}); } catch { if (/\.(m?js|jsx)$/.test(p)) files.push(p); return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = join(p, e.name);
    if (e.isDirectory()) await walk(full); else if (['.js', '.mjs', '.jsx'].includes(extname(e.name))) files.push(full);
  }
}
for (const r of roots) await walk(r);
const missing = new Map();
const re = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|import\s+)['"]([^'"./][^'"]*)['"]/g;
for (const f of files) {
  const src = await readFile(f, 'utf8');
  for (const m of src.matchAll(re)) {
    const spec = m[1];
    if (builtins.has(spec) || builtins.has(spec.split('/')[0])) continue;
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (!declared.has(name)) missing.set(name, [...(missing.get(name) || []), f]);
  }
}
if (missing.size) {
  for (const [n, fs] of missing) console.error(`Undeclared package "${n}" imported by: ${[...new Set(fs)].join(', ')}`);
  process.exit(1);
}
console.log(`check-deps: ${files.length} files, all imported packages are declared.`);
