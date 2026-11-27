import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Gives every build its own service-worker cache name: $RELEASE_ID if set (e.g. the git sha), else the build time.
// Fails the build loudly if sw.js is missing or has no placeholder, so a release can never ship an unversioned worker.
const swRelease = () => ({
  name: 'sw-release',
  apply: 'build',
  closeBundle() {
    const file = fileURLToPath(new URL('./dist/sw.js', import.meta.url));
    let src; try { src = readFileSync(file, 'utf8'); } catch { throw new Error('sw-release: dist/sw.js is missing after the build'); }
    if (!src.includes('__BUILD_ID__')) throw new Error('sw-release: __BUILD_ID__ placeholder not found in dist/sw.js');
    const id = (process.env.RELEASE_ID || Date.now().toString(36)).replace(/[^A-Za-z0-9._-]/g, '');
    if (!id) throw new Error('sw-release: RELEASE_ID has no usable characters');
    writeFileSync(file, src.replaceAll('__BUILD_ID__', id));
  }
});

export default defineConfig({plugins:[react(),swRelease()],root:'client',build:{outDir:'../dist',emptyOutDir:true},server:{port:4173,allowedHosts:['terminal.local'],proxy:{'/api':{target:'http://localhost:4100',ws:true}}}});
