import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/.tools/**', '**/src-tauri/**', '**/artifacts/**', '**/release/**'] },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 1600 },
});
