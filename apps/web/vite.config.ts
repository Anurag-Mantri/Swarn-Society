import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const backend = 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': backend,
      '/auth': backend,
      '/ws': { target: backend, ws: true },
      '/collaboration': { target: backend, ws: true }
    }
  }
});
