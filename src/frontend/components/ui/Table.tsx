import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';

import { cn } from '../../lib/cn';

/**
 * Table primitives. Replaces the per-view `Th` copies and the repeated
 * row/border patterns with one consistent, scrollable, sticky-header table.
 */
export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className={cn('w-full border-collapse text-sm', className)}>{children}</table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead className="sticky top-0 z-10">
      <tr className="border-b border-border">{children}</tr>
    </thead>
  );
}

interface ThProps extends ThHTMLAttributes<HTMLTableCellElement> {
  children: ReactNode;
  align?: 'left' | 'right' | 'center';
}

export function Th({ children, align = 'left', className, ...rest }: ThProps) {
  return (
    <th
      className={cn(
        'whitespace-nowrap bg-surface px-3 py-2.5 text-xs font-semibold uppercase tracking-wider text-faint',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        align === 'left' && 'text-left',
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export function TRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <tr
      className={cn('border-b border-border/60 transition-colors hover:bg-surface-2/50', className)}
    >
      {children}
    </tr>
  );
}

interface TdProps extends TdHTMLAttributes<HTMLTableCellElement> {
  children: ReactNode;
  align?: 'left' | 'right' | 'center';
  numeric?: boolean;
}

export function Td({ children, align = 'left', numeric = false, className, ...rest }: TdProps) {
  return (
    <td
      className={cn(
        'px-3 py-3 text-foreground',
        numeric && 'tabular-nums',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className,
      )}
      {...rest}
    >
      {children}
    </td>
  );
}
