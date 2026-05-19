import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      // ws: true routes WebSocket upgrade requests through to the Fastify WS endpoint.
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
