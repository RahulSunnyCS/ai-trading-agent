import type { NextConfig } from 'next';

/**
 * Browser calls remain same-origin. In local development Next forwards REST
 * calls to Fastify; production can set DASHBOARD_API_URL to its private API
 * origin. WebSocket upgrades use NEXT_PUBLIC_WS_URL instead (see
 * useLiveTicks), because Next rewrites only cover HTTP requests.
 */
const apiOrigin = process.env.DASHBOARD_API_URL ?? 'http://localhost:3000';

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      // Local Options Lab work can still bypass the server stack, matching the
      // retired Vite development convenience. This is never enabled by
      // default or in production.
      ...(process.env.OBT_DIRECT === '1'
        ? [
            {
              source: '/api/backtest/legwise/:path*',
              destination: 'http://127.0.0.1:8000/legwise/:path*',
            },
          ]
        : []),
      // Same idea for the Momentum tab: talk to `mbt ui`'s FastAPI service
      // directly, bypassing Fastify/Postgres/Redis, for local work without the
      // full stack running. Never enabled by default or in production. Mirrors
      // momentum-backtest.ts's own path translation (meta/scores/backtest have
      // different upstream names, so each needs its own rule).
      ...(process.env.MOMENTUM_DIRECT === '1'
        ? [
            { source: '/api/momentum/meta', destination: 'http://127.0.0.1:8765/api/meta' },
            {
              source: '/api/momentum/scores',
              destination: 'http://127.0.0.1:8765/api/momentum-scores',
            },
            {
              source: '/api/momentum/backtest',
              destination: 'http://127.0.0.1:8765/api/backtest',
            },
          ]
        : []),
      { source: '/api/:path*', destination: `${apiOrigin}/api/:path*` },
      { source: '/retrospection/:path*', destination: `${apiOrigin}/retrospection/:path*` },
    ];
  },
};

export default nextConfig;
