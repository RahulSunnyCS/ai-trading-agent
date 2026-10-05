'use client';

/**
 * Loading placeholders for the Momentum sections, each shaped like the content it stands in for
 * so the page does not jump when the data lands. Purely presentational: callers decide when to
 * show them (typically `loading && !data`).
 */

import { Card } from '../ui/Card';
import { Shimmer } from '../ui/Skeleton';

const CHECKBOX_ROWS = ['w-24', 'w-32', 'w-28', 'w-20', 'w-36', 'w-24', 'w-28', 'w-32'];

/** Backtest settings column: the Strategy settings header, the start of the universe picker and
 * the run bar. */
export function MomentumSettingsSkeleton() {
  return (
    <output
      className="block rounded-xl border border-border bg-surface"
      aria-label="Loading strategy settings"
    >
      <div className="flex items-center justify-between px-4 py-3">
        <div className="space-y-2">
          <Shimmer className="h-4 w-32" />
          <Shimmer className="h-3 w-24" />
        </div>
        <Shimmer className="h-8 w-8" />
      </div>
      <div className="space-y-4 border-t border-border p-4">
        <Shimmer className="h-3 w-40" />
        <div className="rounded-lg border border-border p-4">
          <Shimmer className="h-4 w-20" />
          <div className="mt-4 flex gap-1.5">
            {['w-24', 'w-10', 'w-14'].map((width) => (
              <Shimmer key={width} className={`h-6 rounded-full ${width}`} />
            ))}
          </div>
          <Shimmer className="mt-4 h-9 w-full" />
          <div className="mt-4 grid gap-x-10 gap-y-2.5 sm:grid-cols-2">
            {CHECKBOX_ROWS.map((width, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static skeleton
                key={index}
                className="flex items-center gap-2"
              >
                <Shimmer className="h-4 w-4 rounded" />
                <Shimmer className={`h-3.5 ${width}`} />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flex gap-2 border-t border-border px-4 py-3">
        <Shimmer className="h-9 flex-1" />
        <Shimmer className="h-9 w-28" />
      </div>
    </output>
  );
}

/** Momentum Scores: a table header and rows of name + score pills. */
export function MomentumScoresSkeleton({ columns = 5 }: { columns?: number }) {
  return (
    <Card>
      <output className="block" aria-label="Loading momentum scores">
        <div className="flex gap-6 border-b border-border pb-3">
          <Shimmer className="h-3 w-24" />
          <Shimmer className="h-3 w-20" />
          {Array.from({ length: columns }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static skeleton
            <Shimmer key={index} className="ml-auto h-3 w-14" />
          ))}
        </div>
        {Array.from({ length: 10 }, (_, row) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static skeleton
            key={row}
            className="flex items-center gap-6 border-b border-border/60 py-3 last:border-0"
          >
            <div className="w-40 space-y-1.5">
              <Shimmer className="h-3.5 w-20" />
              <Shimmer className="h-3 w-32" />
            </div>
            <Shimmer className="h-3 w-24" />
            {Array.from({ length: columns }, (_, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static skeleton
              <Shimmer key={index} className="ml-auto h-5 w-9" />
            ))}
          </div>
        ))}
      </output>
    </Card>
  );
}

/** A list of bordered rows (saved runs, data sources): a title line and a detail line each. */
export function MomentumListSkeleton({
  rows = 3,
  label,
  bordered = false,
}: {
  rows?: number;
  label: string;
  /** Rows inside one bordered box (the Data & schedule list) instead of top-ruled rows. */
  bordered?: boolean;
}) {
  return (
    <output
      aria-label={label}
      className={
        bordered ? 'block divide-y divide-border rounded-lg border border-border' : 'block'
      }
    >
      {Array.from({ length: rows }, (_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static skeleton
          key={index}
          className={bordered ? 'flex gap-3 px-3 py-3' : 'flex gap-3 border-t border-border py-3'}
        >
          <Shimmer className="h-4 w-4 shrink-0 rounded" />
          <div className="flex-1 space-y-2">
            <Shimmer className={index % 2 ? 'h-3.5 w-48' : 'h-3.5 w-64 max-w-full'} />
            <Shimmer className="h-3 w-full max-w-md" />
          </div>
          <Shimmer className="h-5 w-20 shrink-0" />
        </div>
      ))}
    </output>
  );
}
