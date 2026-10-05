import type { Tab } from './nav';

/**
 * Per-tab "what's still pending to complete" checklists, surfaced via the info
 * icon next to each view's title — only in Developer mode (Settings → About;
 * see ui/PendingInfo). Each entry is a single line, listed in
 * priority order (most foundational first). Grounded in the documented M3/M4
 * gaps and Phase-2 roadmap in .claude/project/overview.md.
 */
export const PENDING_BY_TAB: Record<Tab, string[]> = {
  overview: [],
  live: [
    'Wire /api/straddle/latest — it currently returns a null stub',
    'Add Fyers token auto-refresh (manual daily re-login today — Phase B)',
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
    'Show live progress for running jobs',
    'Add a one-click gap-fill action',
    'Filter by symbol and resolution',
  ],
  replay: [
    'Add a safe server-driven backtest endpoint (M3b, deferred)',
    'Render replay results in the UI',
    'Add one-click dry-run from a coverage row',
  ],
  optionslab: [
    'Run `obt fyers history` once (live Fyers token needed) to unlock the market-regime study',
    'Calibrate the anatomy thresholds (QUIET / TREND) against the backfilled history (TODO 3.10.16)',
    'Join the AlgoTest-history (DSL) sessions to day types — ~63 sessions vs 7 (TODO 3.10.14)',
    'Export DATABASE_URL for obt-api to light up the T-33 cross-check in Market regimes',
    'Fix the pre-Sep-2025 NIFTY expiry calendar so days-to-expiry works on older history (TODO 3.10.15)',
    'Check the engine intrabar rules against a few real trades (optional)',
    'Brokerage/taxes presets instead of a flat per-order cost',
    'Strategy features not built yet: simple momentum, overall trailing/re-entry',
    'YAML mode: weekday buckets alongside the DTE and regime breakdowns (M-5)',
    'YAML mode: walk-forward / sweep reporting and the overfitting guard (M-5)',
    'YAML mode: surface ingest-time quality flags on the run result, not just P&L',
    'YAML mode: an export-to-personality action once a run looks promising (M-5)',
    'Runs: stored YAML runs return headline figures only, and builder (adhoc) runs are not listed by the API',
  ],
  momentum: [
    'Verify every migrated dataset against real Python backtest results',
    'Finish Custom Index inner trade details before declaring Momentum UI parity',
  ],
  brokerLogins: [],
  pricing: [
    'Show the current subscription / credit balance',
    'Add purchase history and receipts',
    'Add GST display and invoicing (Phase 2)',
    'Add international payments via Stripe (Phase 2)',
  ],
  settings: [],
};
