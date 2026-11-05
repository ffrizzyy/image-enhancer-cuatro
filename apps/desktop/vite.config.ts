import path from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const appRoot = path.dirname(fileURLToPath(import.meta.url));

// Renderer is loaded from file://, so asset URLs must be relative.
export default defineConfig({
  root: path.join(appRoot, 'renderer'),
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.join(appRoot, 'dist', 'renderer'),
    emptyOutDir: true,
  },
});
