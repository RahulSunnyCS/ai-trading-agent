'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { cn } from '../../lib/cn';
import { Card } from '../ui/Card';

const SLOW_DATASETS = new Set(['custom_index', 'broad']);

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

function Shimmer({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'animate-shimmer rounded-md bg-[length:200%_100%] bg-[linear-gradient(90deg,hsl(var(--surface-2))_0%,hsl(var(--border))_50%,hsl(var(--surface-2))_100%)]',
        className,
      )}
    />
  );
}

/** Slim "working on it" strip with an elapsed timer, shown for every run. */
export function MomentumRunBanner({
  elapsedMs,
  datasetLabel,
  dataset,
  hasPreviousResult,
}: {
  elapsedMs: number;
  datasetLabel: string;
  dataset: string;
  hasPreviousResult: boolean;
}) {
  const seconds = Math.floor(elapsedMs / 1000);
  const hint =
    seconds < 5
      ? null
      : SLOW_DATASETS.has(dataset)
        ? 'The first run of this strategy builds category rankings and can take up to a minute. Repeat runs reuse them and return in seconds.'
        : 'Still working — longer periods and bigger universes take a little longer.';

  return (
    <output
      aria-live="polite"
      className="block overflow-hidden rounded-xl border border-primary/30 bg-surface shadow-elevated"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 bg-primary/5 px-4 py-3">
        <div className="flex items-center gap-2.5 text-sm font-medium text-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          Running {datasetLabel} backtest
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
