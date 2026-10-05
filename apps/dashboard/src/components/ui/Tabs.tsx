'use client';

import * as RadixTabs from '@radix-ui/react-tabs';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  /** Native tooltip on the tab. */
  title?: string | undefined;
  /** Rendered after the tab, outside its button (a close button, a count). */
  trailing?: ReactNode;
}

interface TabsProps<T extends string> {
  value: T;
  items: ReadonlyArray<TabItem<T>>;
  onChange: (value: T) => void;
  ariaLabel: string;
  /** 'underline' for sections of a page; 'pill' for a compact bar inside a card. */
  variant?: 'underline' | 'pill';
  className?: string;
  /** Tab panels, as <TabPanel value="…"> children. Omit when the caller renders the content. */
  children?: ReactNode;
}

/**
 * The one tab bar. Radix supplies the tablist semantics and keyboard behaviour (arrows, Home,
 * End); the selected tab is controlled by the caller, so it can live in the URL.
 */
export function Tabs<T extends string>({
  value,
  items,
  onChange,
  ariaLabel,
  variant = 'underline',
  className,
  children,
}: TabsProps<T>) {
  return (
    <RadixTabs.Root value={value} onValueChange={(next) => onChange(next as T)}>
      <RadixTabs.List
        aria-label={ariaLabel}
        className={cn(
          'flex max-w-full overflow-x-auto',
          variant === 'underline'
            ? 'gap-4 border-b border-border'
            : 'gap-1 rounded-lg border border-border bg-surface p-1',
          className,
        )}
      >
        {items.map((item) => (
          <span key={item.value} className="flex shrink-0 items-center">
            <RadixTabs.Trigger
              value={item.value}
              disabled={item.disabled}
              title={item.title}
              className={cn(
                'inline-flex items-center gap-2 whitespace-nowrap text-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'disabled:cursor-not-allowed disabled:opacity-50',
                variant === 'underline'
                  ? '-mb-px border-b-2 border-transparent px-1 py-2 text-muted hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground'
                  : 'rounded-md px-3 py-1.5 text-muted hover:text-foreground data-[state=active]:bg-primary data-[state=active]:text-primary-foreground',
              )}
            >
              {item.label}
            </RadixTabs.Trigger>
            {item.trailing}
          </span>
        ))}
      </RadixTabs.List>
      {children}
    </RadixTabs.Root>
  );
}

export function TabPanel({
  value,
  children,
  className,
}: { value: string; children: ReactNode; className?: string }) {
  return (
    <RadixTabs.Content value={value} className={cn('focus-visible:outline-none', className)}>
      {children}
    </RadixTabs.Content>
  );
}
