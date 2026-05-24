/**
 * ReplayView — read-only Replay / Backtest tab.
 *
 * Deterministic replay is intentionally CLI-driven (`bun run replay`), NOT a
 * web-triggered action: the replay pipeline runs the real PositionMonitor,
 * which can close open paper trades against historical prices. Exposing a
 * one-click web trigger would let a misclick mutate live trading state, so this
 * tab is informational only — it documents the CLI workflow and surfaces which
 * backfilled ranges have enough data to replay. A safe server-driven backtest
 * endpoint (isolated, non-mutating) is deferred to a later milestone (M3b).
 *
 * Data source: reuses GET /api/backfill (useBackfillStatus) — ranges with
 * status 'complete' or 'gapped' have candle data and are therefore replayable.
 */

import { useBackfillStatus } from '../hooks/useBackfillStatus.js';
import type { BackfillRangeRow } from '../types/trading.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A range is replayable once its candles are written (complete or gapped). */
function isReplayable(row: BackfillRangeRow): boolean {
  return row.status === 'complete' || row.status === 'gapped';
}

/**
 * Build the exact `bun run replay` command for a backfilled range.
 * --dry-run is suggested first so the user can confirm the load before running
 * the pipeline; the safety guard (--against-live / scratch DB) is documented
 * separately below.
 */
function replayCommand(row: BackfillRangeRow): string {
  return `bun run replay --from ${row.from_ts} --to ${row.to_ts} --underlying ${row.symbol} --dry-run`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function CodeLine({ children }: { children: string }) {
  return (
    <code className="block overflow-x-auto whitespace-pre rounded bg-gray-950 px-3 py-2 font-mono text-xs text-gray-300 ring-1 ring-gray-800">
      {children}
    </code>
  );
}

function HowToRun() {
  return (
    <section className="mb-6">
      <h3 className="mb-2 text-sm font-semibold text-gray-200">How to run a replay</h3>
      <p className="mb-3 text-xs text-gray-400">
        Replay re-runs stored historical ticks through the same live pipeline to produce a
        deterministic, reproducible result. Run it from a shell:
      </p>
      <div className="space-y-2">
        <CodeLine>
          bun run replay --from &lt;ISO&gt; --to &lt;ISO&gt; --underlying NIFTY --dry-run
        </CodeLine>
        <CodeLine>
          bun run replay --from &lt;ISO&gt; --to &lt;ISO&gt; --underlying NIFTY --against-live
        </CodeLine>
      </div>
      <div className="mt-3 rounded-lg border border-amber-800/60 bg-amber-900/20 px-4 py-3">
        <p className="text-xs font-medium text-amber-300">Safety</p>
        <p className="mt-1 text-xs text-amber-600">
          A plain replay runs the real PositionMonitor and can close open paper trades against
          historical prices. Point <code>DATABASE_URL</code> at a scratch database, or use{' '}
          <code>--dry-run</code> to load ticks without running the pipeline. Running against a live
          database requires the explicit <code>--against-live</code> flag (or{' '}
          <code>REPLAY_CONFIRM_LIVE=true</code>).
        </p>
      </div>
    </section>
  );
}

function EmptyCoverage() {
  return (
    <p className="py-6 text-center text-sm text-gray-500">
      No replayable ranges yet — run the historical backfill first (see the Backfill tab).
    </p>
  );
}

function CoverageTable({ ranges }: { ranges: BackfillRangeRow[] }) {
  const fmt = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return (
    <div className="space-y-3">
      {ranges.map((row) => (
        <div key={row.id} className="rounded-lg bg-gray-950/60 p-3 ring-1 ring-gray-800">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="font-medium text-gray-200">
              {row.symbol} · {fmt.format(new Date(row.from_ts))} → {fmt.format(new Date(row.to_ts))}
            </span>
            <span className="tabular-nums text-gray-500">
              {row.rows_written.toLocaleString('en-IN')} candles
              {row.gaps_detected > 0 ? (
                <span className="ml-2 text-amber-400">· {row.gaps_detected} gaps</span>
              ) : null}
            </span>
          </div>
          <CodeLine>{replayCommand(row)}</CodeLine>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Replay tab — documents the deterministic-replay CLI workflow and lists the
 * backfilled ranges that currently have enough data to replay. Read-only.
 */
export function ReplayView() {
  const { ranges, loading, error, refresh } = useBackfillStatus();
  const replayable = ranges.filter(isReplayable);

  return (
    <div className="rounded-lg bg-gray-900 p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Replay / Backtest</h2>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="rounded px-3 py-1.5 text-xs font-medium text-gray-400 ring-1 ring-gray-700 transition-colors hover:bg-gray-800 hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      <HowToRun />

      <section>
        <h3 className="mb-2 text-sm font-semibold text-gray-200">Replayable data coverage</h3>
        {error !== null ? (
          <p className="text-xs text-amber-500">Couldn&apos;t load coverage: {error}</p>
        ) : loading && ranges.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-500">Loading coverage…</p>
        ) : replayable.length === 0 ? (
          <EmptyCoverage />
        ) : (
          <CoverageTable ranges={replayable} />
        )}
      </section>
    </div>
  );
}
