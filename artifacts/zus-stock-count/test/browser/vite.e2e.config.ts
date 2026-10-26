import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const artifactRoot = path.resolve(testDirectory, '../..');

export default defineConfig({
  root: artifactRoot,
  base: '/',
  plugins: [react(), tailwindcss({ optimize: false })],
  resolve: {
    alias: [
      {
        find: /^@\//,
        replacement: `${path.resolve(artifactRoot, 'src')}/`,
      },
      {
        find: /^@clerk\/react\/internal$/,
        replacement: path.resolve(testDirectory, 'mocks/clerk-internal.ts'),
      },
      {
        find: /^@clerk\/react$/,
        replacement: path.resolve(testDirectory, 'mocks/clerk-react.tsx'),
      },
      {
        find: /^@clerk\/themes$/,
        replacement: path.resolve(testDirectory, 'mocks/clerk-themes.ts'),
      },
    ],
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: '127.0.0.1',
    port: 4178,
    strictPort: true,
  },
});
