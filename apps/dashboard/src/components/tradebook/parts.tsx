'use client';

/**
 * Small pieces the Trade book's views share: the widget card (the Analytics page pattern's card
 * below the fold, mounting its content when near the screen), a source badge, a signed rupee
 * figure and the charges bar.
 */

import { type ReactNode, useRef } from 'react';

import { useWidgetActivation } from '../../hooks/useWidgetActivation';
import { cn } from '../../lib/cn';
import { EMPTY, formatInr, formatPct } from '../../lib/format';
import { type ChargePart, sourceMeta } from '../../lib/tradeBookView';
import { Button } from '../ui/Button';
import { SkeletonRows } from '../ui/Skeleton';

export function TradeBookWidget({
  title,
  badge,
  description,
  actions,
  wide = false,
  ready = true,
  className,
  children,
}: {
  title: string;
  /** A short tag after the title (the period it covers). */
  badge?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
  /** False holds the content back (the hero chart has not painted yet). */
  ready?: boolean;
  className?: string;
  children: () => ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const active = useWidgetActivation(ref, { prefetchAfterMs: 400, ready });
  return (
    <section
      ref={ref}
      aria-label={title}
      className={cn(
        'min-w-0 rounded-xl border border-border bg-surface shadow-card',
        wide && 'lg:col-span-2',
        className,
      )}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-1 pt-3">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {badge ? (
          <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">
            {badge}
          </span>
        ) : null}
        {actions ? <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div> : null}
      </header>
      {description ? <p className="px-4 pb-2 text-xs text-faint">{description}</p> : null}
      <div className="px-4 pb-4">{active ? children() : <SkeletonRows rows={5} />}</div>
    </section>
  );
}

/** A widget's own load state: a placeholder, an error with Retry, or its content. */
export function Loaded<T>({
  data,
  loading,
  error,
  retry,
  rows = 5,
  children,
}: {
  data: T | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
  rows?: number;
  children: (data: T) => ReactNode;
}) {
  if (data !== null) {
    return (
      <>
        {error ? <LoadError error={error} retry={retry} /> : null}
        {children(data)}
      </>
    );
  }
  if (error) return <LoadError error={error} retry={retry} />;
  return loading ? <SkeletonRows rows={rows} /> : null;
}

export function LoadError({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div className="mb-2 flex items-center gap-3 rounded-lg border border-negative/30 bg-negative/10 px-3 py-2 text-xs text-negative">
      <span className="min-w-0 flex-1 truncate" title={error}>
        Could not load: {error}
      </span>
      <Button size="sm" variant="ghost" onClick={retry}>
        Retry
      </Button>
    </div>
  );
}

export function SourceBadge({ source }: { source: string }) {
  const meta = sourceMeta(source);
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full border px-2 py-px text-[11px]',
        meta.badge,
      )}
    >
      {meta.label}
    </span>
  );
}

/** A rupee figure coloured by its sign (profit / loss); a missing one is a faint dash. */
export function Inr({
  value,
  signed = true,
  compact = false,
  className,
}: {
  value: number | null | undefined;
  /** Colour by sign. Off for amounts that are not a profit or loss (charges, capital). */
  signed?: boolean;
  compact?: boolean;
  className?: string;
}) {
  if (value === null || value === undefined) {
    return <span className={cn('text-faint', className)}>{EMPTY}</span>;
  }
  return (
    <span
      className={cn(
        signed && value > 0 && 'text-positive',
        signed && value < 0 && 'text-negative',
        className,
      )}
    >
      {formatInr(value, { compact })}
    </span>
  );
}

/** A stacked bar of charge parts with a legend of each part's share. */
export function ChargeBar({ parts, amounts = false }: { parts: ChargePart[]; amounts?: boolean }) {
  const total = parts.reduce((sum, p) => sum + p.amount, 0);
  if (!total) return <p className="text-xs text-faint">No charges in this period.</p>;
  return (
    <div className="space-y-2">
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded">
        {parts.map((p) => (
          <span key={p.key} className={p.swatch} style={{ flex: p.amount }} title={p.label} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {parts.map((p) => (
          <span key={p.key} className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span aria-hidden="true" className={cn('h-2 w-2 rounded-sm', p.swatch)} />
            {p.label}{' '}
            <span className="metric text-foreground">
              {amounts ? formatInr(p.amount) : formatPct(p.amount / total, 0)}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** A label above a value, for the small stat blocks in cards and the drawer. */
export function Stat({
  label,
  children,
  sub,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  sub?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <p className="text-[11px] text-faint">{label}</p>
      <div className="metric mt-0.5 truncate text-lg font-medium text-foreground">{children}</div>
      {sub ? <p className="mt-0.5 truncate text-xs text-muted">{sub}</p> : null}
    </div>
  );
}

/** An on / off button (the hero's panes, the Days table's filter): the dashboard's pressed
 * `Button`, as Momentum's chart toggles are. */
export function Toggle({
  on,
  onChange,
  children,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  children: string;
}) {
  return (
    <Button
      size="sm"
      variant={on ? 'primary' : 'secondary'}
      aria-pressed={on}
      onClick={() => onChange(!on)}
    >
      {children}
    </Button>
  );
}
