'use client';

import { type KeyboardEvent, type ReactNode, createContext, useContext, useRef } from 'react';

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
  /** The selected tab; null (only useful with `onCollapse`) selects none. */
  value: T | null;
  items: ReadonlyArray<TabItem<T>>;
  onChange: (value: T) => void;
  ariaLabel: string;
  /** 'underline' for sections of a page; 'pill' for a compact bar inside a card. */
  variant?: 'underline' | 'pill';
  className?: string;
  /**
   * Makes the bar collapsible: pressing the selected tab again calls this, and the caller sets
   * `value` to null. Tabs are then activated by click / Enter / Space only, not by focus, so
   * tabbing past a collapsed bar does not open a panel.
   */
  onCollapse?: () => void;
  /** Tab panels, as <TabPanel value="…"> children. Omit when the caller renders the content. */
  children?: ReactNode;
  /** Stable DOM id prefix when more than one tab bar shares the same aria label on a page. */
  id?: string;
}

interface TabsContextValue {
  id: string;
  value: string | null;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function stableIdPart(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'tabs';
}

/**
 * The one tab bar. The selected tab is controlled by the caller, so it can live in the URL;
 * keyboard behaviour (arrows, Home, End) stays local and the generated ids stay deterministic.
 */
export function Tabs<T extends string>({
  value,
  items,
  onChange,
  ariaLabel,
  variant = 'underline',
  className,
  onCollapse,
  children,
  id,
}: TabsProps<T>) {
  const tabsId = id ?? `tabs-${stableIdPart(ariaLabel)}`;
  const enabledItems = items.filter((item) => !item.disabled);
  const selectedIndex = items.findIndex((item) => item.value === value);
  const focusIndex = selectedIndex >= 0 ? selectedIndex : items.findIndex((item) => !item.disabled);
  const mouseDownValue = useRef<T | null>(null);

  function select(item: TabItem<T>): void {
    if (item.disabled) return;
    if (onCollapse && item.value === value) {
      onCollapse();
      return;
    }
    onChange(item.value);
  }

  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, direction: 1 | -1): void {
    if (enabledItems.length === 0) return;
    const current = enabledItems.findIndex(
      (item) => item.value === event.currentTarget.dataset.tabsValue,
    );
    const start = current >= 0 ? current : 0;
    const next = enabledItems[(start + direction + enabledItems.length) % enabledItems.length];
    if (!next) return;
    event.preventDefault();
    const target = document.getElementById(`${tabsId}-trigger-${stableIdPart(next.value)}`);
    if (target instanceof HTMLButtonElement) target.focus();
    if (!onCollapse) onChange(next.value);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, item: TabItem<T>): void {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      moveFocus(event, 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      moveFocus(event, -1);
    } else if (event.key === 'Home' || event.key === 'End') {
      if (enabledItems.length === 0) return;
      event.preventDefault();
      const next = event.key === 'Home' ? enabledItems[0] : enabledItems.at(-1);
      if (!next) return;
      const target = document.getElementById(`${tabsId}-trigger-${stableIdPart(next.value)}`);
      if (target instanceof HTMLButtonElement) target.focus();
      if (!onCollapse) onChange(next.value);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select(item);
    }
  }

  return (
    <TabsContext.Provider value={{ id: tabsId, value }}>
      <div>
        <div
          role="tablist"
          aria-label={ariaLabel}
          className={cn(
            'flex max-w-full overflow-x-auto',
            variant === 'underline'
              ? 'gap-4 border-b border-border'
              : 'gap-1 rounded-lg border border-border bg-surface p-1',
            className,
          )}
        >
          {items.map((item, index) => {
            const selected = item.value === value;
            const panelId = `${tabsId}-content-${stableIdPart(item.value)}`;
            const triggerId = `${tabsId}-trigger-${stableIdPart(item.value)}`;
            return (
              <span key={item.value} className="flex shrink-0 items-center">
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  id={triggerId}
                  data-tabs-value={item.value}
                  disabled={item.disabled}
                  title={item.title}
                  tabIndex={selected || (value === null && index === focusIndex) ? 0 : -1}
                  onMouseDown={(event) => {
                    if (event.button !== 0 || event.ctrlKey || item.disabled) return;
                    mouseDownValue.current = item.value;
                    select(item);
                  }}
                  onClick={(event) => {
                    if (event.ctrlKey || item.disabled) return;
                    if (mouseDownValue.current === item.value) {
                      mouseDownValue.current = null;
                      return;
                    }
                    select(item);
                  }}
                  aria-controls={children ? panelId : undefined}
                  onKeyDown={(event) => onKeyDown(event, item)}
                  className={cn(
                    'inline-flex items-center gap-2 whitespace-nowrap text-sm font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                    variant === 'underline'
                      ? '-mb-px border-b-2 border-transparent px-1 py-2 text-muted hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground'
                      : 'rounded-md px-3 py-1.5 text-muted hover:text-foreground data-[state=active]:bg-primary data-[state=active]:text-primary-foreground',
                  )}
                  data-state={selected ? 'active' : 'inactive'}
                >
                  {item.label}
                </button>
                {item.trailing}
              </span>
            );
          })}
        </div>
        {children}
      </div>
    </TabsContext.Provider>
  );
}

export function TabPanel({
  value,
  children,
  className,
}: { value: string; children: ReactNode; className?: string }) {
  const context = useContext(TabsContext);
  const panelId = `${context?.id ?? 'tabs'}-content-${stableIdPart(value)}`;
  const triggerId = `${context?.id ?? 'tabs'}-trigger-${stableIdPart(value)}`;
  if (context && context.value !== value) return null;
  return (
    <div
      role="tabpanel"
      aria-labelledby={triggerId}
      id={panelId}
      className={cn('focus-visible:outline-none', className)}
    >
      {children}
    </div>
  );
}
