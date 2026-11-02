import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],root:'client',build:{outDir:'../dist',emptyOutDir:true},server:{port:4173,allowedHosts:['terminal.local'],proxy:{'/api':{target:'http://localhost:4100',ws:true}}}});
