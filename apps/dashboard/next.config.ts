import type { NextConfig } from 'next';

/**
 * Browser calls remain same-origin. In local development Next forwards REST
 * calls to Fastify; production can set DASHBOARD_API_URL to its private API
 * origin. WebSocket upgrades use NEXT_PUBLIC_WS_URL instead (see
 * useLiveTicks), because Next rewrites only cover HTTP requests.
 */
const apiOrigin = process.env.DASHBOARD_API_URL ?? 'http://localhost:3000';
const momentumDirectOrigin = process.env.MOMENTUM_DIRECT_API_URL ?? 'http://127.0.0.1:8765';

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
      // Same idea for the Momentum tab: talk to its private FastAPI service
      // directly, bypassing Fastify/Postgres/Redis, for local work without the
      // full stack running. Never enabled by default or in production. Mirrors
      // momentum-backtest.ts's own path translation (meta/scores/backtest have
      // different upstream names, so each needs its own rule).
      ...(process.env.MOMENTUM_DIRECT === '1'
        ? [
            {
              source: '/api/auth/fyers/status',
              destination: `${momentumDirectOrigin}/api/auth/fyers/status`,
            },
            {
              source: '/api/auth/fyers/start',
              destination: `${momentumDirectOrigin}/api/auth/fyers/start`,
            },
            {
              source: '/api/auth/fyers/callback',
              destination: `${momentumDirectOrigin}/api/auth/fyers/callback`,
            },
            { source: '/api/momentum/meta', destination: `${momentumDirectOrigin}/api/meta` },
            {
              source: '/api/momentum/scores',
              destination: `${momentumDirectOrigin}/api/momentum-scores`,
            },
            {
              source: '/api/momentum/backtest',
              destination: `${momentumDirectOrigin}/api/backtest`,
            },
            {
              source: '/api/momentum/stock-actions',
              destination: `${momentumDirectOrigin}/api/stock-actions`,
            },
            {
              source: '/api/momentum/stock-actions/review',
              destination: `${momentumDirectOrigin}/api/stock-actions/review`,
            },
            {
              source: '/api/momentum/saved-runs',
              destination: `${momentumDirectOrigin}/api/saved-runs`,
            },
            {
              source: '/api/momentum/saved-runs/:runId',
              destination: `${momentumDirectOrigin}/api/saved-runs/:runId`,
            },
            {
              // run, jobs/latest and status
              source: '/api/momentum/weekly/:path*',
              destination: `${momentumDirectOrigin}/api/weekly/:path*`,
            },
            {
              source: '/api/momentum/rebalance-preview',
              destination: `${momentumDirectOrigin}/api/rebalance-preview`,
            },
          ]
        : []),
      { source: '/api/:path*', destination: `${apiOrigin}/api/:path*` },
      { source: '/retrospection/:path*', destination: `${apiOrigin}/retrospection/:path*` },
    ];
  },
};

export default nextConfig;
