import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Load .env from the repo root (single shared .env for the whole monorepo)
  // instead of this package's own directory. VITE_-prefixed vars (e.g.
  // VITE_RAZORPAY_KEY_ID) are still the only ones exposed to client code.
  envDir: '../../',
  server: {
    port: 5173,
    proxy: {
      // OBT_DIRECT=1 (dev only): send the Options Lab's calls straight to the
      // loopback option-backtesting service (`bun run py:api`, :8000), for
      // working on that tab without Postgres/Redis/apps/server running. Off by
      // default, so normal dev still goes through the Fastify proxy and its
      // access gate — which is the only path in production.
      ...(process.env.OBT_DIRECT === '1'
        ? {
            '/api/backtest/legwise': {
              target: 'http://127.0.0.1:8000',
              rewrite: (path: string) => path.replace(/^\/api\/backtest/, ''),
            },
          }
        : {}),
      '/api': 'http://localhost:3000',
      // The retrospection plugin is fastify-plugin-wrapped and currently mounts
      // its routes at /retrospection/* (the {prefix:'/api'} option passed to
      // register is bypassed by fp). Proxy this path explicitly so the
      // dashboard's Pending Suggestions card can reach it in dev.
      '/retrospection': 'http://localhost:3000',
      // ws: true routes WebSocket upgrade requests through to the Fastify WS endpoint.
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
