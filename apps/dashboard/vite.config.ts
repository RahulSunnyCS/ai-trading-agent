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
