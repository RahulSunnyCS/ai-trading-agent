/**
 * PersonalitiesView — renders the personality engine config table from GET /api/personalities.
 *
 * Display states (mirrors BackfillView pattern):
 *  1. Loading   — pulsing skeleton shimmer
 *  2. Empty     — informational message
 *  3. Error     — amber warning
 *  4. Table     — name/display_name, group_type, entry_type, management_style badge,
 *                 FROZEN badge, active/inactive indicator, phase, key params
 *
 * Management style colour mapping:
 *  hold        → blue
 *  roll        → amber
 *  cut_reenter → purple
 */

import type { ReactNode } from 'react';

import { usePersonalities } from '../hooks/usePersonalities.js';
import type { Personality } from '../types/trading.js';

// ---------------------------------------------------------------------------
// Management style badge
// ---------------------------------------------------------------------------

/**
 * Returns Tailwind classes for each management_style value.
 * Fully explicit switch — no dynamic interpolation — so Tailwind JIT includes
 * all class names in the production bundle.
 */
function managementBadgeClasses(style: string): string {
  switch (style) {
    case 'hold':
      return 'bg-blue-900/60 text-blue-300 ring-1 ring-blue-700';
    case 'roll':
      return 'bg-amber-900/60 text-amber-300 ring-1 ring-amber-700';
    case 'cut_reenter':
      return 'bg-purple-900/60 text-purple-300 ring-1 ring-purple-700';
    default:
      return 'bg-gray-800 text-gray-400 ring-1 ring-gray-700';
  }
}

function ManagementBadge({ style }: { style: string }) {
  // Display labels: cut_reenter → "Cut+Re-enter" for readability.
  const label =
    style === 'cut_reenter' ? 'Cut+Re-enter' : style.charAt(0).toUpperCase() + style.slice(1);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${managementBadgeClasses(style)}`}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Frozen badge
// ---------------------------------------------------------------------------

function FrozenBadge() {
  // No emoji per project conventions — plain text label.
  return (
    <span className="inline-flex items-center rounded-full bg-gray-800 px-2 py-0.5 text-xs font-semibold text-gray-400 ring-1 ring-gray-600">
      FROZEN
    </span>
  );
}

// ---------------------------------------------------------------------------
// Active indicator
// ---------------------------------------------------------------------------

function ActiveIndicator({ isActive }: { isActive: boolean }) {
  if (isActive) {
    return <span className="inline-block h-2 w-2 rounded-full bg-green-400" title="Active" />;
  }
  return <span className="inline-block h-2 w-2 rounded-full bg-gray-600" title="Inactive" />;
}

// ---------------------------------------------------------------------------
// Params summary
// ---------------------------------------------------------------------------

/**
 * Renders a compact one-line summary of the key personality params.
 * Only shows min_probability when present — other params are omitted to keep
 * the table narrow. Full params are available via the evolution engine UI (Phase 2+).
 */
function ParamsSummary({ params }: { params: Record<string, unknown> }) {
  const parts: string[] = [];

  if (typeof params.min_probability === 'number') {
    parts.push(`min_prob: ${(params.min_probability * 100).toFixed(0)}%`);
  }
  if (typeof params.sl_pct === 'number') {
    parts.push(`sl: ${params.sl_pct}%`);
  }

  if (parts.length === 0) {
    return <span className="text-xs text-gray-600">—</span>;
  }

  return <span className="text-xs tabular-nums text-gray-400">{parts.join(' · ')}</span>;
}

// ---------------------------------------------------------------------------
// State-specific render helpers
// ---------------------------------------------------------------------------

function LoadingState() {
  return (
    // biome-ignore lint/a11y/useSemanticElements: role="status" live region for loading state; <output> would alter block layout.
    <div className="space-y-2 pt-4" role="status" aria-label="Loading personalities">
      {Array.from({ length: 5 }, (_, i) => `personalities-skeleton-${i}`).map((key) => (
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
          d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"
        />
      </svg>
      <p className="text-sm font-medium text-gray-400">No personalities found.</p>
      <p className="mt-1 text-xs text-gray-600">
        Personality configs appear once the M2 seed migration has run.
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
          Couldn&apos;t load personalities — retrying&hellip;
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

function PersonalitiesTable({ personalities }: { personalities: Personality[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-gray-800">
            <Th>Status</Th>
            <Th>Name</Th>
            <Th>Group</Th>
            <Th>Entry Type</Th>
            <Th>Management</Th>
            <Th>Phase</Th>
            <Th>Key Params</Th>
          </tr>
        </thead>
        <tbody>
          {personalities.map((p) => (
            // id is the PK UUID; guaranteed unique per row.
            <tr
              key={p.id}
              className="border-b border-gray-800/50 transition-colors hover:bg-gray-800/30"
            >
              <td className="px-3 py-3">
                <div className="flex items-center gap-2">
                  <ActiveIndicator isActive={p.is_active} />
                  {p.is_frozen && <FrozenBadge />}
                </div>
              </td>
              <td className="px-3 py-3">
                <span className="font-medium text-gray-100">{p.display_name}</span>
                <span className="ml-1.5 text-xs text-gray-500">{p.name}</span>
              </td>
              <td className="px-3 py-3 text-gray-400 capitalize">{p.group_type}</td>
              <td className="px-3 py-3 text-gray-400">
                {/* Render entry_type with underscores as spaces for readability. */}
                {p.entry_type.replace(/_/g, ' ')}
              </td>
              <td className="px-3 py-3">
                <ManagementBadge style={p.management_style} />
              </td>
              <td className="px-3 py-3 tabular-nums text-gray-400">{p.phase}</td>
              <td className="px-3 py-3">
                <ParamsSummary params={p.params} />
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
 * Personalities tab — fetches /api/personalities and renders the config table.
 *
 * Shows only active personalities by default.
 * A toggle lets the user include inactive personalities.
 * A Refresh button re-fetches without leaving the tab.
 */
export function PersonalitiesView() {
  const { personalities, loading, error, refresh } = usePersonalities();

  return (
    <div className="rounded-lg bg-gray-900 p-4">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">Trading Personalities</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Active personality configurations for the M2 engine
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="rounded px-3 py-1.5 text-xs font-medium text-gray-400 ring-1 ring-gray-700 transition-colors hover:bg-gray-800 hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      {loading && personalities.length === 0 && <LoadingState />}
      {error !== null && <ErrorState message={error} />}
      {!loading && error === null && personalities.length === 0 && <EmptyState />}
      {personalities.length > 0 && <PersonalitiesTable personalities={personalities} />}
    </div>
  );
}
