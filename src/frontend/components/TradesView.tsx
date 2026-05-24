/**
 * TradesView — renders the paper trades log polled from GET /api/trades.
 *
 * Three distinct display states:
 *  1. Loading   — skeleton/spinner shown on initial load (loading: true)
 *  2. Empty     — calm "no trades yet" message (trades.length === 0, no error)
 *  3. Error     — visually distinct warning with retry language
 *  4. Table     — list of trades with colour-coded P&L
 *
 * P&L columns:
 *  - Positive → green   (text-green-400)
 *  - Negative → red     (text-red-400)
 *  - Zero     → neutral (text-gray-300)
 *  - null     → em dash  "—" (open trades have no realised P&L yet)
 */

import { usePaperTrades } from '../hooks/usePaperTrades.js';
import { formatIstDateTime, formatPnl, toNumberOrNull } from '../lib/format.js';
import { type PaperTrade } from '../types/trading.js';

// ---------------------------------------------------------------------------
// Sub-components / helpers
// ---------------------------------------------------------------------------

/**
 * Colour-codes a P&L cell based on sign.
 * Returns an em dash when the raw value is null (open trades).
 */
function PnlCell({ raw }: { raw: string | null }) {
  const value = toNumberOrNull(raw);

  if (value === null) {
    // Open trade — no realised P&L yet.  Never show "0" for a null value.
    return <span className="text-gray-500">—</span>;
  }

  if (value > 0) {
    return <span className="font-medium text-green-400">{formatPnl(value)}</span>;
  }
  if (value < 0) {
    return <span className="font-medium text-red-400">{formatPnl(value)}</span>;
  }
  // Exactly zero — neither profit nor loss.
  return <span className="text-gray-300">{formatPnl(value)}</span>;
}

/**
 * Status badge — green for open trades, gray for closed.
 * Uses a pill shape so it stands out in the table without dominating.
 */
function StatusBadge({ status }: { status: PaperTrade['status'] }) {
  const isOpen = status === 'open';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
        isOpen
          ? 'bg-green-900/60 text-green-300 ring-1 ring-green-700'
          : 'bg-gray-800 text-gray-400 ring-1 ring-gray-700'
      }`}
    >
      {isOpen ? 'Open' : 'Closed'}
    </span>
  );
}

/**
 * Render a single straddle-at-entry cell.
 * The value is a NUMERIC string from the DB; null means it was not recorded.
 */
function StraddleCell({ raw }: { raw: string | null }) {
  const value = toNumberOrNull(raw);
  if (value === null) return <span className="text-gray-500">—</span>;
  // Format with 2 decimal places; no sign prefix needed (always positive entry).
  return (
    <span className="tabular-nums">
      {new Intl.NumberFormat('en-IN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// State-specific render helpers
// ---------------------------------------------------------------------------

/**
 * Shown while the very first fetch is in-flight (loading: true, no prior data).
 * A simple pulsing shimmer conveys activity without a spinner library.
 */
function LoadingState() {
  return (
    <div className="space-y-2 pt-4" role="status" aria-label="Loading trades">
      {[...Array(3)].map((_, i) => (
        <div
          key={i}
          className="h-10 animate-pulse rounded bg-gray-800"
          aria-hidden="true"
        />
      ))}
    </div>
  );
}

/**
 * Shown when the fetch succeeded but the server returned zero trades.
 * This is the "calm no-activity day" state — no alarm, just informational.
 */
function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <svg
        className="mb-3 h-10 w-10 text-gray-700"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7"
        />
      </svg>
      <p className="text-sm font-medium text-gray-400">No paper trades yet.</p>
      <p className="mt-1 text-xs text-gray-600">
        Trades will appear here once the engine enters a position.
      </p>
    </div>
  );
}

/**
 * Shown when the fetch returned a network or HTTP error.
 *
 * Intentionally visually distinct from EmptyState:
 *  - Amber/yellow warning colour instead of neutral gray
 *  - Explicit "Couldn't load trades" wording — not a calm no-activity message
 *  - "retrying…" language signals the hook keeps polling in the background
 *
 * We do NOT use red here because a fetch failure is a transient operational
 * issue, not a data-loss alarm.  Amber is the conventional "degraded" colour.
 */
function ErrorState({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="mt-4 flex items-start gap-3 rounded-lg border border-amber-800/60 bg-amber-900/20 px-4 py-3"
    >
      <svg
        className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-400"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
        />
      </svg>
      <div>
        <p className="text-sm font-medium text-amber-300">
          Couldn&apos;t load trades — retrying&hellip;
        </p>
        {/* Surface the raw error detail for debugging; kept subtle so it does
            not alarm non-technical users but is visible when needed. */}
        <p className="mt-0.5 text-xs text-amber-600">{message}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trades table
// ---------------------------------------------------------------------------

/**
 * Column header cell — consistent padding + text style.
 */
function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className="whitespace-nowrap px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500"
    >
      {children}
    </th>
  );
}

/**
 * Renders the actual trades table once we have data.
 * Newest-first sort is intentional: traders care about the most recent trade
 * at a glance.  We sort client-side so the hook stays general-purpose.
 */
function TradesTable({ trades }: { trades: PaperTrade[] }) {
  // Sort newest entry_time first without mutating the original array.
  const sorted = [...trades].sort(
    (a, b) => new Date(b.entry_time).getTime() - new Date(a.entry_time).getTime(),
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-gray-800">
            <Th>Entry Time (IST)</Th>
            <Th>Status</Th>
            <Th>Straddle @ Entry</Th>
            <Th>Gross P&amp;L</Th>
            <Th>Net P&amp;L</Th>
            <Th>Exit Reason</Th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((trade) => (
            <tr
              key={trade.id}
              className="border-b border-gray-800/50 transition-colors hover:bg-gray-800/30"
            >
              <td className="px-3 py-3 tabular-nums text-gray-200">
                {formatIstDateTime(trade.entry_time)}
              </td>
              <td className="px-3 py-3">
                <StatusBadge status={trade.status} />
              </td>
              <td className="px-3 py-3 text-gray-200">
                <StraddleCell raw={trade.straddle_at_entry} />
              </td>
              <td className="px-3 py-3">
                <PnlCell raw={trade.gross_pnl} />
              </td>
              <td className="px-3 py-3">
                <PnlCell raw={trade.net_pnl} />
              </td>
              <td className="px-3 py-3 text-gray-400">
                {trade.exit_reason ?? <span className="text-gray-600">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Trades tab — polls /api/trades and renders the paper trade log.
 *
 * Reuses usePaperTrades so T-03 (PnlView) can import the same hook without
 * duplicating the fetch and polling logic.
 */
export function TradesView() {
  const { trades, loading, error } = usePaperTrades();

  return (
    <div className="rounded-lg bg-gray-900 p-4">
      <h2 className="text-lg font-semibold text-white">Paper Trades</h2>

      {/* While loading and no prior data, show the skeleton shimmer.
          After the first successful fetch, loading flips to false — subsequent
          background re-polls do not re-show this state (trades stays populated). */}
      {loading && trades.length === 0 && <LoadingState />}

      {/* Error banner — shown regardless of whether trades is populated.
          If we have stale data + a new error, both the table and the banner
          are shown so the user can see the last-known state alongside the alert. */}
      {error !== null && <ErrorState message={error} />}

      {/* Empty state — only shown when there is no error and no trades. */}
      {!loading && error === null && trades.length === 0 && <EmptyState />}

      {/* Table — rendered whenever there is data, even if an error is also
          present (stale-but-visible is better than blank). */}
      {trades.length > 0 && <TradesTable trades={trades} />}
    </div>
  );
}
