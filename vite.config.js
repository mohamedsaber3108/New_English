import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Gives every build its own service-worker cache name: $RELEASE_ID if set (e.g. the git sha), else the build time.
const swRelease = () => ({
  name: 'sw-release',
  apply: 'build',
  closeBundle() {
    const file = fileURLToPath(new URL('./dist/sw.js', import.meta.url));
    let src; try { src = readFileSync(file, 'utf8'); } catch { return; }
    const id = (process.env.RELEASE_ID || Date.now().toString(36)).replace(/[^A-Za-z0-9._-]/g, '');
    writeFileSync(file, src.replace('__BUILD_ID__', id));
  }
});

export default defineConfig({plugins:[react(),swRelease()],root:'client',build:{outDir:'../dist',emptyOutDir:true},server:{port:4173,allowedHosts:['terminal.local'],proxy:{'/api':{target:'http://localhost:4100',ws:true}}}});
