'use client';

import { Play, RotateCw } from 'lucide-react';
import type { Ref } from 'react';

import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';

/**
 * The run controls, pinned to the bottom of the settings column (and to the bottom of the
 * viewport on a narrow screen), so Run is reachable from any setting without scrolling. A failed
 * run's reason shows here, right by the button that was pressed.
 */
export function MomentumRunBar({
  starting,
  disabled,
  dirty,
  hasRun,
  inFlightCount,
  runError,
  runErrorRef,
  onRun,
}: {
  /** Which button's request is being sent, if any. */
  starting: 'run' | 'fresh' | null;
  /** Settings have not loaded yet. */
  disabled: boolean;
  /** The form differs from the run on screen. */
  dirty: boolean;
  /** A finished run is on screen. */
  hasRun: boolean;
  inFlightCount: number;
  runError: string | null;
  runErrorRef: Ref<HTMLDivElement>;
  onRun: (options: { fresh: boolean }) => void;
}) {
  const busy = starting !== null;
  return (
    <div className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-10 space-y-2 rounded-b-xl border-t border-border bg-surface px-4 py-3 md:bottom-0 xl:static">
      {runError ? (
        <div
          ref={runErrorRef}
          role="alert"
          className="rounded-lg border border-negative/30 bg-negative/10 px-3 py-2 text-sm text-negative"
        >
          <p className="font-medium">The run didn&apos;t finish</p>
          <p className="mt-0.5 text-foreground/80">{runError}</p>
        </div>
      ) : null}
      {dirty || inFlightCount > 0 ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          {dirty ? <Badge tone="warning">Changed since last run</Badge> : null}
          {inFlightCount > 0 ? (
            <span>{inFlightCount} running — starting another runs it alongside</span>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          className="flex-1 whitespace-nowrap"
          loading={starting === 'run'}
          disabled={busy || disabled}
          onClick={() => onRun({ fresh: false })}
          title="Run the backtest with these settings (Ctrl/Cmd + Enter)"
        >
          {starting === 'run' ? null : <Play className="h-3.5 w-3.5" aria-hidden="true" />}
          {starting === 'run'
            ? 'Starting…'
            : dirty && hasRun
              ? 'Run again'
              : 'Run momentum backtest'}
        </Button>
        <Button
          loading={starting === 'fresh'}
          disabled={busy || disabled}
          onClick={() => onRun({ fresh: true })}
          title="Re-run from scratch: drops the server's cached rankings and data, reloads them, then recomputes. Slower; use it when the numbers look stale."
        >
          {starting === 'fresh' ? null : <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />}
          Re-run fresh
        </Button>
      </div>
      <p className="hidden text-[11px] text-faint sm:block">
        Ctrl/Cmd + Enter runs from any setting.
      </p>
    </div>
  );
}
