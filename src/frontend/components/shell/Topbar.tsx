import { Menu } from 'lucide-react';

import { ThemeToggle } from '../ui/ThemeToggle';
import { SystemStatus } from './SystemStatus';

interface TopbarProps {
  title: string;
  subtitle?: string;
  /** Opens the mobile nav drawer (button only shown below lg). */
  onOpenMenu: () => void;
}

/**
 * Sticky page header: mobile menu trigger + current view title on the left,
 * live system status + theme toggle on the right.
 */
export function Topbar({ title, subtitle, onOpenMenu }: TopbarProps) {
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur sm:px-6">
      <button
        type="button"
        onClick={onOpenMenu}
        aria-label="Open navigation"
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-surface text-muted transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
      >
        <Menu className="h-4 w-4" />
      </button>

      <div className="min-w-0">
        <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">{title}</h1>
        {subtitle ? <p className="truncate text-xs text-muted">{subtitle}</p> : null}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <SystemStatus />
        <ThemeToggle />
      </div>
    </header>
  );
}
