// Runs as `pretest`: the observability test serves the built frontend, so build it once if dist/ is missing (T-1).
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
if (existsSync(`${root}dist/index.html`)) process.exit(0);
console.log('dist/ missing - running `vite build` first');
const r = spawnSync(process.execPath, [`${root}node_modules/vite/bin/vite.js`, 'build'], {cwd: root, stdio: 'inherit'});
process.exit(r.status ?? 1);
