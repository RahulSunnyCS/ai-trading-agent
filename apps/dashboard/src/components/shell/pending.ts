import type { Tab } from './nav';

/**
 * Per-tab "what's still pending to complete" checklists, surfaced via the info
 * icon next to each view's title. Each entry is a single line, listed in
 * priority order (most foundational first). Grounded in the documented M3/M4
 * gaps and Phase-2 roadmap in .claude/project/overview.md.
 */
export const PENDING_BY_TAB: Record<Tab, string[]> = {
  live: [
    'Wire /api/straddle/latest — it currently returns a null stub',
    'Add Fyers token auto-refresh (manual daily re-login today — Phase B)',
    'Encrypt broker_tokens at rest (Phase B)',
    'Add FYERS_PIN support (Phase B)',
    'Surface the India VIX value alongside the straddle',
  ],
  trades: [
    'Add status / date-range / personality filters',
    'Paginate or virtualize the log for large histories',
    'Show management style and full exit detail per trade',
    'Add CSV export',
  ],
  personalities: [
    'Show live running P&L per personality',
    'Add the Beat-Clockwork delta column',
    'Surface the full parameter set and evolution history',
    'Add the parameter-suggestion approval UI (Phase 2)',
  ],
  pnl: [
    'Add a per-personality P&L breakdown',
    'Add a date-range filter and FY presets',
    'Show unrealized P&L for open positions (needs live marks)',
    'Add drawdown and win/loss-streak metrics',
  ],
  regime: [
    'Add per-regime statistical reporting (T-58, deferred)',
    'Add a regime filter and date range',
    'Add a regime-distribution chart',
    'Link regimes to per-personality performance',
  ],
  backfill: [
    'Add an in-UI trigger to start a backfill (CLI-only today)',
    'Show live progress for running jobs',
    'Add a one-click gap-fill action',
    'Filter by symbol and resolution',
  ],
  replay: [
    'Add a safe server-driven backtest endpoint (M3b, deferred)',
    'Build the backtest runner (T-51, deferred)',
    'Render replay results in the UI',
    'Add one-click dry-run from a coverage row',
  ],
  pricing: [
    'Show the current subscription / credit balance',
    'Add purchase history and receipts',
    'Add GST display and invoicing (Phase 2)',
    'Add international payments via Stripe (Phase 2)',
  ],
};
