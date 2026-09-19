import { cn } from '../../lib/cn';
import { BrandIcon, NAV_GROUPS, type Tab } from './nav';

interface SidebarProps {
  activeTab: Tab;
  onSelect: (tab: Tab) => void;
  /** Called after a selection so the mobile drawer can close itself. */
  onNavigate?: () => void;
}

/**
 * Grouped navigation rail. Shared by the desktop fixed sidebar and the mobile
 * drawer. Purely presentational — the active tab + selection handler are owned
 * by App.
 */
export function Sidebar({ activeTab, onSelect, onNavigate }: SidebarProps) {
  return (
    <div className="flex h-full flex-col gap-6 px-3 py-5">
      <div className="flex items-center gap-2.5 px-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <BrandIcon className="h-4 w-4" />
        </span>
        <div className="leading-tight">
          <div className="font-serif text-[15px] font-semibold tracking-tight text-foreground">
            AI Trading Agent
          </div>
          <div className="text-[11px] text-faint">Research console</div>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-5">
        {NAV_GROUPS.map((group) => (
          <div key={group.heading} className="flex flex-col gap-1">
            <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
              {group.heading}
            </div>
            {group.items.map((item) => {
              const Icon = item.icon;
              const active = item.id === activeTab;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    onSelect(item.id);
                    onNavigate?.();
                  }}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'bg-primary/12 text-primary'
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
                </button>
              );
            })}
          </div>
        ))}
      </nav>
    </div>
  );
}
