import type { NextConfig } from 'next';

/**
 * Browser calls remain same-origin. In local development Next forwards REST
 * calls to Fastify; production can set DASHBOARD_API_URL to its private API
 * origin. WebSocket upgrades use NEXT_PUBLIC_WS_URL instead (see
 * useLiveTicks), because Next rewrites only cover HTTP requests.
 */
const apiOrigin = process.env.DASHBOARD_API_URL ?? 'http://localhost:3000';
const momentumDirectOrigin = process.env.MOMENTUM_DIRECT_API_URL ?? 'http://127.0.0.1:8765';
// Both direct origins may be a Cloudflare Tunnel hostname when the dashboard runs off the
// backend laptop (docs/remote-dashboard.md); middleware.ts adds the Access service token.
const optionsDirectOrigin = process.env.OBT_DIRECT_API_URL ?? 'http://127.0.0.1:8000';
const schedulerDirectOrigin = process.env.SCHEDULER_DIRECT_API_URL ?? 'http://127.0.0.1:8790';

// Sent on every response: no framing (clickjacking), no MIME sniffing, no cross-site referrer.
const SECURITY_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
  // `bun run start:prod` builds into .next-prod so a concurrent `next dev` can't overwrite it.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // A cold whole-market Broad Momentum run (or Custom Index) takes about a minute; Next's default
  // 30s rewrite-proxy timeout would drop it as a 500. Matches the Fastify proxy's 180s.
  experimental: { proxyTimeout: 180_000 },
  // The Guide's pages are Markdown files imported as strings (`import body from './x.md?raw'`,
  // BL-041). Vitest understands `?raw` natively; webpack needs this one rule.
  webpack(config) {
    config.module.rules.push({ resourceQuery: /raw/, type: 'asset/source' });
    return config;
  },
  async rewrites() {
    return [
      // Local Options Lab work can still bypass the server stack, matching the
      // retired Vite development convenience. This is never enabled by
      // default or in production.
      ...(process.env.OBT_DIRECT === '1'
        ? [
            {
              source: '/api/backtest/legwise/:path*',
              destination: `${optionsDirectOrigin}/legwise/:path*`,
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
              source: '/api/momentum/scores/stock/:symbol',
              destination: `${momentumDirectOrigin}/api/momentum-scores/stock/:symbol`,
            },
            {
              source: '/api/momentum/scores/stock/:symbol/circuits',
              destination: `${momentumDirectOrigin}/api/momentum-scores/stock/:symbol/circuits`,
            },
            {
              source: '/api/momentum/backtest',
              destination: `${momentumDirectOrigin}/api/backtest`,
            },
            {
              source: '/api/momentum/backtest/jobs',
              destination: `${momentumDirectOrigin}/api/backtest/jobs`,
            },
            {
              source: '/api/momentum/backtest/jobs/:id',
              destination: `${momentumDirectOrigin}/api/backtest/jobs/:id`,
            },
            {
              source: '/api/momentum/backtest/jobs/:id/sections/:section',
              destination: `${momentumDirectOrigin}/api/backtest/jobs/:id/sections/:section`,
            },
            {
              source: '/api/momentum/liquidity-preview',
              destination: `${momentumDirectOrigin}/api/liquidity-preview`,
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
              source: '/api/momentum/saved-strategies',
              destination: `${momentumDirectOrigin}/api/saved-strategies`,
            },
            {
              source: '/api/momentum/result-changes',
              destination: `${momentumDirectOrigin}/api/result-changes`,
            },
            {
              // BL-052: one strategy per set of settings (+ `merge`, `:runId`), and the log of
              // why a result moved (+ `:changeId/reviewed`).
              source: '/api/momentum/saved-strategies/:path*',
              destination: `${momentumDirectOrigin}/api/saved-strategies/:path*`,
            },
            {
              source: '/api/momentum/result-changes/:path*',
              destination: `${momentumDirectOrigin}/api/result-changes/:path*`,
            },
            {
              // Weekly signal's favourites + Telegram-active strategy. Without this rule the call
              // fell through to Fastify (not running in this mode) and 500'd silently.
              source: '/api/momentum/favorite-strategies',
              destination: `${momentumDirectOrigin}/api/favorite-strategies`,
            },
            {
              source: '/api/momentum/journal',
              destination: `${momentumDirectOrigin}/api/journal`,
            },
            {
              source: '/api/momentum/week',
              destination: `${momentumDirectOrigin}/api/week`,
            },
            {
              source: '/api/momentum/live-rules',
              destination: `${momentumDirectOrigin}/api/live-rules`,
            },
            {
              source: '/api/momentum/live-rules/:path*',
              destination: `${momentumDirectOrigin}/api/live-rules/:path*`,
            },
            {
              source: '/api/momentum/alerts',
              destination: `${momentumDirectOrigin}/api/alerts`,
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
            {
              source: '/api/momentum/rebalance-preview/jobs',
              destination: `${momentumDirectOrigin}/api/rebalance-preview/jobs`,
            },
            {
              source: '/api/momentum/rebalance-preview/jobs/:id',
              destination: `${momentumDirectOrigin}/api/rebalance-preview/jobs/:id`,
            },
          ]
        : []),
      // The scheduler's loopback API (apps/scheduler, BL-012): Jobs and Notifications pages.
      // Must stay before the catch-all below. Never enabled in a plain production build.
      ...(process.env.SCHEDULER_DIRECT === '1'
        ? [
            {
              source: '/api/scheduler/:path*',
              destination: `${schedulerDirectOrigin}/:path*`,
            },
          ]
        : []),
      { source: '/api/:path*', destination: `${apiOrigin}/api/:path*` },
      { source: '/retrospection/:path*', destination: `${apiOrigin}/retrospection/:path*` },
    ];
  },
};

export default nextConfig;
