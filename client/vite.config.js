import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The API is proxied rather than called cross-origin.
 *
 * StockPulse authenticates with an HttpOnly cookie plus a CSRF double-submit
 * token. Proxying keeps the browser talking to a single origin in development,
 * which means the cookie is first-party and neither CORS preflights nor
 * SameSite rules enter the picture -- the same shape the app has in production
 * behind one host. Set VITE_API_URL to bypass the proxy and hit an API on
 * another origin directly (the server's CORS_ORIGIN must allow it).
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:4000' },
      '/health': { target: 'http://localhost:4000' },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});