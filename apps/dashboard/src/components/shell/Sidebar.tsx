import type { MouseEvent } from 'react';

import { cn } from '../../lib/cn';
import { buildPath } from '../../lib/routes';
import type { NavigationPreferences } from '../../store/navigation';
import { visibleNavigationGroups } from '../../store/navigation';
import { BrandIcon, type Tab, activeNavChild } from './nav';

interface SidebarProps {
  activeTab: Tab;
  /** Path segments after the active tab; picks the highlighted nested link. */
  activeRest: readonly string[];
  onSelect: (tab: Tab, ...rest: string[]) => void;
  preferences: NavigationPreferences;
  /** Called after a selection so the mobile drawer can close itself. */
  onNavigate?: () => void;
  /** The icon rail of an analytics page: icons only (the name on hover), no nested links. */
  compact?: boolean;
}

/** A plain left click navigates in place; modified clicks keep the browser's behaviour. */
function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * Grouped navigation rail. Shared by the desktop fixed sidebar and the mobile
 * drawer. Purely presentational — the active route + selection handler are
 * owned by App. Every entry is a real link, so it can be opened in a new tab.
 */
export function Sidebar({
  activeTab,
  activeRest,
  onSelect,
  preferences,
  onNavigate,
  compact = false,
}: SidebarProps) {
  const groups = visibleNavigationGroups(preferences);

  function go(event: MouseEvent, tab: Tab, ...rest: string[]): void {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    onSelect(tab, ...rest);
    onNavigate?.();
  }

  if (compact) {
    return (
      <div className="flex h-full flex-col items-center gap-4 overflow-y-auto py-4">
        <span
          className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground"
          title="AI Trading Agent"
        >
          <BrandIcon className="h-4 w-4" />
        </span>
        <nav aria-label="Primary" className="flex flex-col items-center gap-3">
          {groups.map((group) => (
            <div
              key={group.id}
              className="flex flex-col items-center gap-1 border-t border-border pt-3 first:border-t-0 first:pt-0"
            >
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = item.id === activeTab;
                return (
                  <a
                    key={item.id}
                    href={buildPath(item.id)}
                    onClick={(event) => {
                      if (active && isPlainClick(event)) {
                        event.preventDefault();
                        return;
                      }
                      go(event, item.id);
                    }}
                    aria-label={item.label}
                    title={item.label}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex h-9 w-9 items-center justify-center rounded-lg transition-colors',
                      FOCUS_RING,
                      active
                        ? 'bg-primary/10 text-primary'
                        : 'text-faint hover:bg-surface-2 hover:text-foreground',
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </a>
                );
              })}
            </div>
          ))}
        </nav>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto px-3 py-5">
      <div className="flex items-center gap-2.5 px-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <BrandIcon className="h-4 w-4" />
        </span>
        <div className="leading-tight">
          <div className="text-[15px] font-semibold tracking-tight text-foreground">
            AI Trading Agent
          </div>
          <div className="text-[11px] text-faint">Research console</div>
        </div>
      </div>

      <nav aria-label="Primary" className="flex flex-1 flex-col gap-5">
        {groups.map((group) => (
          <div key={group.id} className="flex flex-col gap-1">
            <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
              {group.heading}
            </div>
            {group.items.map((item) => {
              const Icon = item.icon;
              const active = item.id === activeTab;
              const activeChild = active ? activeNavChild(item, activeRest) : undefined;
              return (
                <div key={item.id} className="flex flex-col gap-0.5">
                  <a
                    href={buildPath(item.id)}
                    onClick={(event) => {
                      // Already on this tab: stay on the current sub-route instead of
                      // resetting it to the tab's default.
                      if (active && isPlainClick(event)) {
                        event.preventDefault();
                        onNavigate?.();
                        return;
                      }
                      go(event, item.id);
                    }}
                    // With nested links, the nested one is the current page.
                    aria-current={active && !activeChild ? 'page' : undefined}
                    className={cn(
                      'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                      FOCUS_RING,
                      active
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted hover:bg-surface-2 hover:text-foreground',
                    )}
                  >
                    <Icon
                      className={cn(
                        'h-4 w-4 shrink-0',
                        active ? 'text-primary' : 'text-faint group-hover:text-muted',
                      )}
                    />
                    {item.label}
                  </a>
                  {active && item.children ? (
                    <div className="ml-5 flex flex-col gap-0.5 border-l border-border pl-2">
                      {item.children.map((child) => {
                        const current = child === activeChild;
                        return (
                          <a
                            key={child.segment}
                            href={buildPath(item.id, child.segment)}
                            onClick={(event) => {
                              if (current && isPlainClick(event)) {
                                event.preventDefault();
                                onNavigate?.();
                                return;
                              }
                              go(event, item.id, child.segment);
                            }}
                            aria-current={current ? 'page' : undefined}
                            className={cn(
                              'rounded-md px-3 py-1.5 text-[13px] transition-colors',
                              FOCUS_RING,
                              current
                                ? 'font-medium text-primary'
                                : 'text-muted hover:bg-surface-2 hover:text-foreground',
                            )}
                          >
                            {child.label}
                          </a>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
      </nav>
    </div>
  );
}
