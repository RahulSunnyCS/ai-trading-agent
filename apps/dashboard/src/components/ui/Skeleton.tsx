import { cn } from '../../lib/cn';

/** Calm loading placeholder. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-surface-2', className)} />;
}

/** A stack of skeleton rows — the standard "table is loading" treatment. */
export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-2.5', className)}>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static skeleton
        <Skeleton key={i} className="h-11 w-full" />
      ))}
    </div>
  );
}
