/**
 * ReplayView — read-only Replay / Backtest tab.
 *
 * Deterministic replay is intentionally CLI-driven (`bun run replay`), NOT a
 * web-triggered action (a misclick could close open paper trades against
 * historical prices). This tab documents the CLI workflow and lists which
 * backfilled ranges have enough data to replay.
 *
 * Data source: reuses GET /api/backfill (useBackfillStatus) — ranges with
 * status 'completed' have candle data and are therefore replayable.
 */

import { AlertTriangle } from 'lucide-react';

import { useBackfillStatus } from '../hooks/useBackfillStatus';
import { isReplayable } from '../lib/backfill';
import { formatInt, formatIstDate } from '../lib/format';
import type { BackfillRangeRow } from '../types/trading';
import { Card, CardHeader } from './ui/Card';
import { CodeBlock } from './ui/CodeBlock';
import { CopyButton } from './ui/CopyButton';
import { RefreshButton } from './ui/RefreshButton';
import { StateMessage } from './ui/StateMessage';

function replayCommand(row: BackfillRangeRow): string {
  return `bun run replay --from ${row.from_ts} --to ${row.to_ts} --underlying ${row.symbol} --dry-run`;
}

const HOW_TO_COMMANDS = [
  'bun run replay --from <ISO> --to <ISO> --underlying NIFTY --dry-run',
  'bun run replay --from <ISO> --to <ISO> --underlying NIFTY --against-live',
];

/** A command line with a copy button beside it. */
function CommandLine({ command }: { command: string }) {
  return (
    <div className="flex items-center gap-2">
      <CodeBlock className="min-w-0 flex-1 whitespace-pre">{command}</CodeBlock>
      <CopyButton text={command} label="Copy command" />
    </div>
  );
}

function HowToRun() {
  return (
    <Card>
      <CardHeader
        title="How to run a replay"
        description="Replay re-runs stored historical ticks through the same live pipeline to produce a deterministic, reproducible result. Run it from a shell:"
      />
      <div className="space-y-2">
        {HOW_TO_COMMANDS.map((command) => (
          <CommandLine key={command} command={command} />
        ))}
      </div>
      <div className="mt-4 flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="text-sm">
          <p className="font-medium text-foreground">Safety</p>
          <p className="mt-1 text-muted">
            A plain replay runs the real PositionMonitor and can close open paper trades against
            historical prices. Point <code className="font-mono text-foreground">DATABASE_URL</code>{' '}
            at a scratch database, or use{' '}
            <code className="font-mono text-foreground">--dry-run</code> to load ticks without
            running the pipeline. Running against a live database requires the explicit{' '}
            <code className="font-mono text-foreground">--against-live</code> flag (or{' '}
            <code className="font-mono text-foreground">REPLAY_CONFIRM_LIVE=true</code>).
          </p>
        </div>
      </div>
    </Card>
  );
}

function CoverageList({ ranges }: { ranges: BackfillRangeRow[] }) {
  return (
    <div className="space-y-3">
      {ranges.map((row) => (
        <div key={row.id} className="rounded-lg border border-border bg-surface-2/50 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="font-medium text-foreground">
              {row.symbol} · {formatIstDate(row.from_ts)} → {formatIstDate(row.to_ts)}
            </span>
            <span className="tabular-nums text-faint">
              {formatInt(row.rows_written)} candles
              {row.gaps_detected > 0 ? (
                <span className="ml-2 text-warning">· {row.gaps_detected} gaps</span>
              ) : null}
            </span>
          </div>
          <CommandLine command={replayCommand(row)} />
        </div>
      ))}
    </div>
  );
}

export function ReplayView() {
  const { ranges, loading, error, refresh } = useBackfillStatus();
  const replayable = ranges.filter(isReplayable);

  return (
    <div className="space-y-5">
      <HowToRun />

      <Card>
        <CardHeader
          title="Replayable data coverage"
          description="Backfilled ranges with enough candle data to replay"
          actions={<RefreshButton onClick={refresh} loading={loading} />}
        />
        {error !== null ? (
          <StateMessage
            variant="error"
            title="Couldn't load coverage — retrying…"
            description={error}
          />
        ) : loading && ranges.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">Loading coverage…</p>
        ) : replayable.length === 0 ? (
          <StateMessage
            variant="empty"
            title="No replayable ranges yet"
            description="Run the historical backfill first (see the Backfill tab)."
          />
        ) : (
          <CoverageList ranges={replayable} />
        )}
      </Card>
    </div>
  );
}
