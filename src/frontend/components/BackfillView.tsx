/**
 * BackfillView — renders the backfill job history from GET /api/backfill.
 *
 * Display states (mirrors TradesView pattern):
 *  1. Loading   — pulsing skeleton shimmer
 *  2. Empty     — informational message
 *  3. Error     — amber warning
 *  4. Table     — symbol, from→to date range, resolution, status badge,
 *                 rows_written, gaps_detected
 *
 * Status colour mapping:
 *  complete → green
 *  running  → blue (in-progress)
 *  partial  → amber (resumable)
 *  gapped   → amber (gaps found)
 *  pending  → gray
 *  error    → red
 */

import type { ReactNode } from 'react';

import { useBackfillStatus } from '../hooks/useBackfillStatus.js';
import type { BackfillRangeRow } from '../types/trading.js';

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

/**
 * Returns Tailwind classes for each backfill status.
 * Fully explicit switch — no dynamic interpolation — so Tailwind JIT includes
 * all class names in the build bundle.
 */
function statusBadgeClasses(status: string): string {
  switch (status) {
    case 'complete':
      return 'bg-green-900/60 text-green-300 ring-1 ring-green-700';
    case 'running':
      return 'bg-blue-900/60 text-blue-300 ring-1 ring-blue-700';
    case 'partial':
    case 'gapped':
      return 'bg-amber-900/60 text-amber-300 ring-1 ring-amber-700';
    case 'error':
      return 'bg-red-900/60 text-red-300 ring-1 ring-red-700';
    default:
      // pending or unknown
      return 'bg-gray-800 text-gray-400 ring-1 ring-gray-700';
  }
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${statusBadgeClasses(status)}`}
    >
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Date range cell
// ---------------------------------------------------------------------------

/**
 * Formats a from_ts → to_ts pair as a compact "DD/MM/YYYY → DD/MM/YYYY" string.
 * Both values are ISO-8601 strings serialised from TIMESTAMPTZ columns.
 */
function DateRangeCell({ from, to }: { from: string; to: string }) {
  const fmt = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return (
    <span className="tabular-nums text-gray-200">
      {fmt.format(new Date(from))} → {fmt.format(new Date(to))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// State-specific render helpers
// ---------------------------------------------------------------------------

function LoadingState() {
  return (
    // biome-ignore lint/a11y/useSemanticElements: role="status" live region for loading state; <output> would alter block layout.
    <div className="space-y-2 pt-4" role="status" aria-label="Loading backfill status">
      {Array.from({ length: 4 }, (_, i) => `backfill-skeleton-${i}`).map((key) => (
        <div key={key} className="h-10 animate-pulse rounded bg-gray-800" aria-hidden="true" />
      ))}
    </div>
  );
}

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
          d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125"
        />
      </svg>
      <p className="text-sm font-medium text-gray-400">No backfill jobs yet.</p>
      <p className="mt-1 text-xs text-gray-600">
        Backfill ranges appear once the historical data ingestion pipeline has run.
      </p>
    </div>
  );
}

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
          Couldn&apos;t load backfill status — retrying&hellip;
        </p>
        <p className="mt-0.5 text-xs text-amber-600">{message}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

function Th({ children }: { children: ReactNode }) {
  return (
    <th
      scope="col"
      className="whitespace-nowrap px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500"
    >
      {children}
    </th>
  );
}

function BackfillTable({ ranges }: { ranges: BackfillRangeRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-gray-800">
            <Th>Symbol</Th>
            <Th>Date Range</Th>
            <Th>Resolution</Th>
            <Th>Status</Th>
            <Th>Rows Written</Th>
            <Th>Gaps</Th>
          </tr>
        </thead>
        <tbody>
          {ranges.map((row) => (
            // id is the PK; guaranteed unique per row.
            <tr
              key={row.id}
              className="border-b border-gray-800/50 transition-colors hover:bg-gray-800/30"
            >
              <td className="px-3 py-3 font-medium text-gray-200">{row.symbol}</td>
              <td className="px-3 py-3">
                <DateRangeCell from={row.from_ts} to={row.to_ts} />
              </td>
              <td className="px-3 py-3 text-gray-400">{row.resolution}</td>
              <td className="px-3 py-3">
                <StatusBadge status={row.status} />
              </td>
              <td className="px-3 py-3 tabular-nums text-gray-200">
                {row.rows_written.toLocaleString('en-IN')}
              </td>
              <td className="px-3 py-3 tabular-nums">
                {row.gaps_detected > 0 ? (
                  <span className="font-medium text-amber-400">{row.gaps_detected}</span>
                ) : (
                  <span className="text-gray-500">0</span>
                )}
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
 * Backfill tab — fetches /api/backfill and renders the job history table.
 *
 * Shows all symbols by default (no symbol filter in the URL).
 * A Refresh button lets the user re-fetch without leaving the tab.
 */
export function BackfillView() {
  const { ranges, loading, error, refresh } = useBackfillStatus();

  return (
    <div className="rounded-lg bg-gray-900 p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Backfill Status</h2>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="rounded px-3 py-1.5 text-xs font-medium text-gray-400 ring-1 ring-gray-700 transition-colors hover:bg-gray-800 hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      {loading && ranges.length === 0 && <LoadingState />}
      {error !== null && <ErrorState message={error} />}
      {!loading && error === null && ranges.length === 0 && <EmptyState />}
      {ranges.length > 0 && <BackfillTable ranges={ranges} />}
    </div>
  );
}
