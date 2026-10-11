import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

// Local only: bind to 127.0.0.1 and proxy the API (which is also bound to 127.0.0.1). WEB_PORT / PORT change the ports.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WEB_PORT ?? 5180),
    strictPort: true,
    // the UI must not be framed by another site (clickjacking), sniffed or leak its address in a Referer
    headers: {
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
    proxy: { '/api': `http://127.0.0.1:${process.env.PORT ?? 4310}` },
  },
});
