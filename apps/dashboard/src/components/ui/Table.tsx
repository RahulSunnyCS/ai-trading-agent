import type { KeyboardEvent, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';

import { cn } from '../../lib/cn';

/**
 * Table primitives. Replaces the per-view `Th` copies and the repeated
 * row/border patterns with one consistent, scrollable, sticky-header table.
 */
export function Table({
  children,
  className,
  maxHeight,
  stickyFirstCol = false,
}: {
  children: ReactNode;
  className?: string;
  /**
   * Caps the table's height and scrolls it inside its own box. This is what makes the header
   * stick: a sticky header only works when the scrolling box is the table's own wrapper.
   */
  maxHeight?: number | string;
  /** Keeps the first column in view while the rest scrolls sideways. */
  stickyFirstCol?: boolean;
}) {
  return (
    <div
      className={cn('-mx-1 overflow-x-auto', maxHeight !== undefined && 'overflow-y-auto')}
      style={maxHeight !== undefined ? { maxHeight } : undefined}
    >
      <table
        className={cn(
          'w-full border-collapse text-sm',
          stickyFirstCol &&
            '[&_td:first-child]:sticky [&_td:first-child]:left-0 [&_td:first-child]:z-[1] [&_td:first-child]:bg-surface [&_th:first-child]:sticky [&_th:first-child]:left-0 [&_th:first-child]:z-[2]',
          className,
        )}
      >
        {children}
      </table>
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
  /** Matches `Td dense`: the same tighter sides. */
  dense?: boolean;
}

export function Th({ children, align = 'left', dense = false, className, ...rest }: ThProps) {
  return (
    <th
      className={cn(
        'whitespace-nowrap bg-surface py-2.5 text-xs font-semibold uppercase tracking-wider text-faint',
        dense ? 'px-2' : 'px-3',
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

export function TRow({
  children,
  className,
  onClick,
  selected,
}: {
  children: ReactNode;
  className?: string;
  /** Makes the whole row a control: clickable, focusable, and activated by Enter or Space. */
  onClick?: (() => void) | undefined;
  selected?: boolean | undefined;
}) {
  return (
    <tr
      className={cn(
        'border-b border-border/60 transition-colors hover:bg-surface-2/50',
        onClick &&
          'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        selected && 'bg-surface-2/60',
        className,
      )}
      {...(onClick
        ? {
            tabIndex: 0,
            'aria-selected': selected,
            onClick,
            onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onClick();
              }
            },
          }
        : {})}
    >
      {children}
    </tr>
  );
}

interface TdProps extends TdHTMLAttributes<HTMLTableCellElement> {
  children: ReactNode;
  align?: 'left' | 'right' | 'center';
  numeric?: boolean;
  /** Tighter cells for a long list read at a glance (about 32 px a row with one-line content). */
  dense?: boolean;
}

export function Td({
  children,
  align = 'left',
  numeric = false,
  dense = false,
  className,
  ...rest
}: TdProps) {
  return (
    <td
      className={cn(
        dense ? 'px-2 py-1' : 'px-3 py-3',
        'text-foreground',
        numeric && 'font-mono tabular-nums',
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
