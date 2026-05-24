/**
 * RegimeView — renders the daily regime tag history from GET /api/regime-tags.
 *
 * Display states (mirrors TradesView pattern):
 *  1. Loading   — pulsing skeleton shimmer (loading: true, no prior data)
 *  2. Empty     — calm informational message (tags.length === 0, no error)
 *  3. Error     — amber warning with retry language
 *  4. Table     — date, symbol, colour-coded regime badge, confidence %
 *
 * Regime colour mapping:
 *  RANGING            → blue
 *  TRENDING_STRONG    → green
 *  VOLATILE_REVERTING → amber
 *  EVENT_DAY          → purple
 *  UNCLASSIFIED       → gray
 */

import type { ReactNode } from 'react';

import { useRegimeTags } from '../hooks/useRegimeTags.js';
import type { RegimeTag } from '../types/trading.js';

// ---------------------------------------------------------------------------
// Regime badge
// ---------------------------------------------------------------------------

/**
 * Colour-coded pill badge for each regime value.
 * Using a function with explicit branches keeps the Tailwind class names static
 * so the JIT compiler can detect and include them at build time — dynamic class
 * interpolation (e.g. `text-${colour}-400`) is not safe with Tailwind JIT.
 */
function regimeBadgeClasses(regime: string): string {
  switch (regime) {
    case 'RANGING':
      return 'bg-blue-900/60 text-blue-300 ring-1 ring-blue-700';
    case 'TRENDING_STRONG':
      return 'bg-green-900/60 text-green-300 ring-1 ring-green-700';
    case 'VOLATILE_REVERTING':
      return 'bg-amber-900/60 text-amber-300 ring-1 ring-amber-700';
    case 'EVENT_DAY':
      return 'bg-purple-900/60 text-purple-300 ring-1 ring-purple-700';
    default:
      // UNCLASSIFIED or any unexpected value
      return 'bg-gray-800 text-gray-400 ring-1 ring-gray-700';
  }
}

function RegimeBadge({ regime }: { regime: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${regimeBadgeClasses(regime)}`}
    >
      {regime}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Confidence cell
// ---------------------------------------------------------------------------

/**
 * Renders regime_confidence as a percentage string.
 * The value arrives as a raw NUMERIC string from pg (e.g. "0.8500").
 * null is displayed as an em dash.
 */
function ConfidenceCell({ raw }: { raw: string | null }) {
  if (raw === null) return <span className="text-gray-500">—</span>;
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n)) return <span className="text-gray-500">—</span>;
  return (
    <span className="tabular-nums text-gray-200">
      {new Intl.NumberFormat('en-IN', {
        style: 'percent',
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }).format(n)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Date cell
// ---------------------------------------------------------------------------

/**
 * Formats a trade_date ISO string (midnight UTC) as a plain IST calendar date.
 * We only care about the date part — time is always 00:00 and irrelevant here.
 */
function DateCell({ iso }: { iso: string }) {
  // en-IN locale + IST timezone gives the correct Indian calendar date.
  const formatted = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
  return <span className="tabular-nums text-gray-200">{formatted}</span>;
}

// ---------------------------------------------------------------------------
// State-specific render helpers (mirror TradesView exactly)
// ---------------------------------------------------------------------------

function LoadingState() {
  return (
    // biome-ignore lint/a11y/useSemanticElements: role="status" live region for loading state; <output> would alter block layout.
    <div className="space-y-2 pt-4" role="status" aria-label="Loading regime tags">
      {Array.from({ length: 5 }, (_, i) => `regime-skeleton-${i}`).map((key) => (
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
          d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"
        />
      </svg>
      <p className="text-sm font-medium text-gray-400">No regime tags yet.</p>
      <p className="mt-1 text-xs text-gray-600">
        Tags appear after the EOD retrospection engine classifies at least one trading day.
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
          Couldn&apos;t load regime tags — retrying&hellip;
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

function RegimeTable({ tags }: { tags: RegimeTag[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-gray-800">
            <Th>Date (IST)</Th>
            <Th>Symbol</Th>
            <Th>Regime</Th>
            <Th>Confidence</Th>
            <Th>Classified At (IST)</Th>
          </tr>
        </thead>
        <tbody>
          {tags.map((tag) => (
            // Use trade_date + symbol as the key: the pair is unique per row.
            <tr
              key={`${tag.trade_date}-${tag.symbol}`}
              className="border-b border-gray-800/50 transition-colors hover:bg-gray-800/30"
            >
              <td className="px-3 py-3">
                <DateCell iso={tag.trade_date} />
              </td>
              <td className="px-3 py-3 text-gray-300">{tag.symbol}</td>
              <td className="px-3 py-3">
                <RegimeBadge regime={tag.regime} />
              </td>
              <td className="px-3 py-3">
                <ConfidenceCell raw={tag.regime_confidence} />
              </td>
              <td className="px-3 py-3 tabular-nums text-gray-400">
                {new Intl.DateTimeFormat('en-IN', {
                  timeZone: 'Asia/Kolkata',
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                }).format(new Date(tag.classified_at))}
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
 * Regime tab — fetches /api/regime-tags and renders the daily regime history.
 *
 * Defaults to the last 30 days of NIFTY data (server-side default range).
 * A Refresh button allows the user to re-fetch without leaving the tab.
 */
export function RegimeView() {
  const { tags, loading, error, refresh } = useRegimeTags();

  return (
    <div className="rounded-lg bg-gray-900 p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Daily Regime Tags</h2>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="rounded px-3 py-1.5 text-xs font-medium text-gray-400 ring-1 ring-gray-700 transition-colors hover:bg-gray-800 hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      {loading && tags.length === 0 && <LoadingState />}
      {error !== null && <ErrorState message={error} />}
      {!loading && error === null && tags.length === 0 && <EmptyState />}
      {tags.length > 0 && <RegimeTable tags={tags} />}
    </div>
  );
}
