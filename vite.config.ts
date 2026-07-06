import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
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
