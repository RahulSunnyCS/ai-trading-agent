import { RefreshCw } from 'lucide-react';

import { cn } from '../../lib/cn';
import { Button } from './Button';

/** The standard "Refresh" action: the icon spins and the button is disabled while loading. */
export function RefreshButton({
  onClick,
  loading = false,
  label = 'Refresh',
  disabled = false,
  title,
  className,
}: {
  onClick: () => void;
  loading?: boolean;
  label?: string;
  /** Disabled for a reason other than its own loading. */
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <Button
      size="sm"
      onClick={onClick}
      disabled={loading || disabled}
      title={title}
      className={className}
    >
      <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden="true" />
      {label}
    </Button>
  );
}
