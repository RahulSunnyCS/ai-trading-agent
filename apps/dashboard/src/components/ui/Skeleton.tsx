import { cn } from '../../lib/cn';

/** Calm loading placeholder. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn('animate-pulse rounded-md bg-surface-2', className)} />
  );
}

/** A stack of skeleton rows — the standard "table is loading" treatment. */
export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <output aria-busy="true" aria-label="Loading" className={cn('block space-y-2.5', className)}>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static skeleton
        <Skeleton key={i} className="h-11 w-full" />
      ))}
    </output>
  );
}

/**
 * A placeholder with a light sweeping across it — for content that is on its way, shaped like
 * that content so nothing jumps when it lands. Size and shape come from `className`; `inline`
 * sits it in a line of text (it is a <span>, so it is valid inside a <p>).
 */
export function Shimmer({ className, inline = false }: { className?: string; inline?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        inline ? 'inline-block align-middle' : 'block',
        'animate-shimmer rounded-md bg-[length:200%_100%] bg-[linear-gradient(90deg,hsl(var(--surface-2))_0%,hsl(var(--border))_50%,hsl(var(--surface-2))_100%)]',
        className,
      )}
    />
  );
}
