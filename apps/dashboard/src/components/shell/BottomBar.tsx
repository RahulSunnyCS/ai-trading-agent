import { Menu } from 'lucide-react';

import { cn } from '../../lib/cn';
import { buildPath } from '../../lib/routes';
import type { NavigationPreferences } from '../../store/navigation';
import { visibleNavigationGroups } from '../../store/navigation';
import { type Tab, tabGroupId } from './nav';

interface BottomBarProps {
  activeTab: Tab;
  onSelect: (tab: Tab) => void;
  preferences: NavigationPreferences;
  /** Opens the navigation drawer with every tab. */
  onOpenMenu: () => void;
  /** True while that drawer is open. */
  menuOpen: boolean;
}

const ITEM =
  'flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 py-2 text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring';

/**
 * Mobile-only (below `md`) bottom tab bar: one entry per navigation section,
 * each opening that section's first visible tab, plus "More" for the drawer
 * with the full navigation. Sections whose tabs are all hidden drop out.
 *
 * It is fixed to the viewport, so the main content needs matching bottom
 * padding (see App).
 */
export function BottomBar({
  activeTab,
  onSelect,
  preferences,
  onOpenMenu,
  menuOpen,
}: BottomBarProps) {
  const groups = visibleNavigationGroups(preferences);
  const activeGroup = tabGroupId(activeTab);

  return (
    <nav
      aria-label="Sections"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <div className="flex items-stretch">
        {groups.map((group) => {
          const target = group.items[0];
          if (!target) return null;
          const Icon = group.icon;
          const active = group.id === activeGroup;
          return (
            <a
              key={group.id}
              href={buildPath(target.id)}
              onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
                event.preventDefault();
                // Already on the target tab: keep its current sub-route.
                if (target.id !== activeTab) onSelect(target.id);
              }}
              aria-current={active ? 'true' : undefined}
              className={cn(ITEM, active ? 'text-primary' : 'text-muted hover:text-foreground')}
            >
              <Icon className="h-5 w-5 shrink-0" />
              <span className="max-w-full truncate">{group.heading}</span>
            </a>
          );
        })}
        <button
          type="button"
          onClick={onOpenMenu}
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          className={cn(ITEM, 'text-muted hover:text-foreground')}
        >
          <Menu className="h-5 w-5 shrink-0" />
          <span className="max-w-full truncate">More</span>
        </button>
      </div>
    </nav>
  );
}
