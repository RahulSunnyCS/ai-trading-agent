/**
 * ReplayView — Data › Coverage › Replay (read-only).
 *
 * Deterministic replay is intentionally CLI-driven (`bun run replay`), NOT a
 * web-triggered action (a misclick could close open paper trades against
 * historical prices). This section documents the CLI workflow and lists which
 * backfilled ranges have enough data to replay.
 *
 * Data source: reuses GET /api/backfill (useBackfillStatus) — ranges with
 * status 'completed' have candle data and are therefore replayable. Every command line, the
 * how-to's and each row's, comes from `replayCommand` in lib/backfill.ts, so they share the
 * underlying format the CLI accepts (NIFTY, not NSE:NIFTY50-INDEX).
 */

import { AlertTriangle } from 'lucide-react';

import { useAppRoute } from '../hooks/useAppRoute';
import { useBackfillStatus } from '../hooks/useBackfillStatus';
import {
  isReplayable,
  replayCommand,
  resolutionLabel,
  rowReplayCommand,
  symbolLabel,
} from '../lib/backfill';
import { formatInt, formatIstDate } from '../lib/format';
import type { BackfillRangeRow } from '../types/trading';
import { Button } from './ui/Button';
import { Card, CardHeader } from './ui/Card';
import { CodeBlock } from './ui/CodeBlock';
import { CopyButton } from './ui/CopyButton';
import { RefreshButton } from './ui/RefreshButton';
import { SkeletonRows } from './ui/Skeleton';
import { StateMessage } from './ui/StateMessage';

const HOW_TO_COMMANDS = (['dry-run', 'against-live'] as const).map((mode) =>
  replayCommand({ from: '<ISO>', to: '<ISO>', underlying: 'NIFTY', mode }),
);

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
        description="Replay re-runs stored historical ticks through the same live pipeline to produce a deterministic, reproducible result. Run it from a shell at the repo root; --underlying takes NIFTY, BANKNIFTY or SENSEX:"
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
      {ranges.map((row) => {
        const command = rowReplayCommand(row);
        return (
          <div key={row.id} className="rounded-lg border border-border bg-surface-2/50 p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="font-medium text-foreground">
                <span title={row.symbol}>{symbolLabel(row.symbol)}</span> ·{' '}
                {resolutionLabel(row.resolution)} · {formatIstDate(row.from_ts)} →{' '}
                {formatIstDate(row.to_ts)}
              </span>
              <span className="tabular-nums text-faint">
                {formatInt(row.rows_written)} candles
                {row.gaps_detected > 0 ? (
                  <span className="ml-2 text-warning">· {formatInt(row.gaps_detected)} gaps</span>
                ) : null}
              </span>
            </div>
            {command !== null ? (
              <CommandLine command={command} />
            ) : (
              <p className="text-sm text-muted">The replay CLI does not support this symbol.</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ReplayView() {
  const { ranges, loading, error, refresh } = useBackfillStatus();
  const { navigate } = useAppRoute();
  const replayable = ranges.filter(isReplayable);

  return (
    <div className="space-y-5">
      <HowToRun />

      <Card>
        <CardHeader
          title="Replayable data coverage"
          description="Completed backfills, each with its dry-run command"
          actions={<RefreshButton onClick={refresh} loading={loading} />}
        />
        {error !== null ? (
          <StateMessage variant="error" title="Couldn't load coverage" description={error} />
        ) : loading && ranges.length === 0 ? (
          <SkeletonRows rows={3} />
        ) : replayable.length === 0 ? (
          <div className="space-y-3">
            <StateMessage
              variant="empty"
              title="No replayable ranges yet"
              description="A range becomes replayable once its backfill completes."
            />
            <div className="flex justify-center">
              <Button size="sm" onClick={() => navigate('coverage', 'backfill')}>
                Go to Backfill
              </Button>
            </div>
          </div>
        ) : (
          <CoverageList ranges={replayable} />
        )}
      </Card>
    </div>
  );
}
