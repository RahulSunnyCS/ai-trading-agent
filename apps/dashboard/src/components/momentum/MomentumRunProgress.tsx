'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { cn } from '../../lib/cn';
import { describeDuration } from '../../lib/momentumDurations';
import { Card } from '../ui/Card';
import { Shimmer } from '../ui/Skeleton';

const SLOW_DATASETS = new Set(['custom_index', 'broad']);

/** What to call each step a run goes through on the server. */
const STAGE_LABELS: Record<string, string> = {
  loading: 'Loading prices',
  ranking: 'Ranking',
  simulating: 'Simulating the weekly trades',
  analysing: 'Preparing the results',
};

/** The order to assume until the server sends its own (each job carries the ordered list). */
const DEFAULT_STAGES = Object.keys(STAGE_LABELS);

/**
 * "Step 2 of 4 · Ranking" for a step the server reported, or null when there is none or it is not
 * in the list. The order and the count come from the server's list, so a step added there is
 * numbered correctly; only its label, if it has none here, falls back to its capitalised name.
 */
export function describeStage(
  stage: string | null | undefined,
  stages: readonly string[] = DEFAULT_STAGES,
): string | null {
  const index = stage ? stages.indexOf(stage) : -1;
  if (!stage || index < 0) return null;
  const label = STAGE_LABELS[stage] ?? `${stage.charAt(0).toUpperCase()}${stage.slice(1)}`;
  return `Step ${index + 1} of ${stages.length} · ${label}`;
}

/**
 * True for ~2s after `key` changes (a run finishing). Every results card uses it, so whichever
 * card is on screen when a run lands is the one that visibly glows.
 */
export function useResultFlash(key: number | null): boolean {
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    if (key === null) return;
    setFlashing(true);
    const timer = setTimeout(() => setFlashing(false), 2300);
    return () => clearTimeout(timer);
  }, [key]);
  return flashing;
}

/** Slim "working on it" strip with an elapsed timer, shown for every run. */
export function MomentumRunBanner({
  elapsedMs,
  datasetLabel,
  dataset,
  hasPreviousResult,
  queued = false,
  stage = null,
  stages,
  usualMs = null,
}: {
  elapsedMs: number;
  datasetLabel: string;
  dataset: string;
  hasPreviousResult: boolean;
  /** Waiting for a free slot behind other runs, not computing yet. */
  queued?: boolean;
  /** The step the server says it has reached ("ranking", …). */
  stage?: string | null;
  /** The server's ordered list of steps, as the job reported it. */
  stages?: readonly string[] | undefined;
  /** How long a real run of this dataset usually takes here, once one has been seen. */
  usualMs?: number | null;
}) {
  const seconds = Math.floor(elapsedMs / 1000);
  const step = queued ? null : describeStage(stage, stages);
  const reason = SLOW_DATASETS.has(dataset)
    ? 'The first run of this strategy builds category rankings and can take up to a minute. Repeat runs reuse them and return in seconds.'
    : 'Still working — longer periods and bigger universes take a little longer.';
  // The usual time is the middle of recent runs, cached ones and cold ones together, so a run that
  // needs to rebuild its rankings can take several times longer. Past twice the usual time, say why
  // instead of repeating an estimate that is plainly wrong.
  const usualTime = usualMs ? describeDuration(usualMs) : null;
  const overrun = usualMs !== null && elapsedMs > usualMs * 2;
  const hint =
    seconds < 5
      ? null
      : usualTime && !overrun
        ? `Usually ${usualTime}.`
        : usualTime
          ? `Taking longer than the usual ${usualTime}. ${reason}`
          : reason;

  return (
    <output
      aria-live="polite"
      className="block overflow-hidden rounded-xl border border-primary/30 bg-surface shadow-elevated"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 bg-primary/5 px-4 py-3">
        <div className="flex items-center gap-2.5 text-sm font-medium text-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          {queued
            ? `Queued ${datasetLabel} backtest — waiting for other runs to finish`
            : `Running ${datasetLabel} backtest`}
          {step ? <span className="text-xs font-normal text-muted">· {step}</span> : null}
          {hasPreviousResult ? (
            <span className="text-xs font-normal text-muted">
              · previous results shown faded until this finishes
            </span>
          ) : null}
        </div>
        <span className="font-mono text-xs tabular-nums text-muted">{seconds}s</span>
      </div>
      {hint ? <p className="bg-primary/5 px-4 pb-3 text-xs text-muted">{hint}</p> : null}
      <div className="h-1 w-full bg-primary/10">
        <div className="h-full w-full animate-shimmer bg-[length:50%_100%] bg-no-repeat bg-[linear-gradient(90deg,transparent_0%,hsl(var(--primary))_50%,transparent_100%)]" />
      </div>
    </output>
  );
}

/** First-run placeholder shaped like the real results, so nothing jumps when they land. */
export function MomentumResultsSkeleton() {
  return (
    <div className="space-y-5" aria-hidden="true">
      <Card>
        <Shimmer className="h-3 w-24" />
        <Shimmer className="mt-2 h-5 w-72 max-w-full" />
        <div className="mt-4 flex flex-wrap gap-1.5">
          {['w-28', 'w-20', 'w-32', 'w-16', 'w-24'].map((width) => (
            <Shimmer key={width} className={cn('h-6 rounded-full', width)} />
          ))}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {['a', 'b', 'c', 'd', 'e'].map((key) => (
            <div key={key} className="rounded-lg border border-border bg-surface-2/40 px-4 py-3.5">
              <Shimmer className="h-3 w-20" />
              <Shimmer className="mt-3 h-7 w-24" />
              <Shimmer className="mt-2 h-3 w-28" />
            </div>
          ))}
        </div>
        <Shimmer className="mt-3 h-10 w-full" />
      </Card>
      <Card>
        <Shimmer className="h-4 w-48" />
        <Shimmer className="mt-4 h-[380px] w-full" />
      </Card>
    </div>
  );
}
