import { AlertTriangle, ExternalLink, LogIn } from 'lucide-react';

import { useFyersAuthStatus } from '../../hooks/useFyersAuthStatus';
import { useMeta } from '../../hooks/useMeta';
import { cn } from '../../lib/cn';
import { startFyersLogin } from '../../lib/fyers-login';
import { formatCountdown } from '../../lib/market';
import { useSettingsStore } from '../../store/settings';
import { Button } from '../ui/Button';

/**
 * Slim banner for under the top bar: warns from two hours before the Fyers token expires and
 * says so once it has, with the Login button inline. Renders nothing in simulation mode (no
 * token is needed), when Fyers login is not configured, and when the token is fine or there
 * has never been one (the status cluster and the Broker logins card cover "no token").
 */
export function TokenBanner() {
  // Settings › Notifications: the banner can be switched off in this browser.
  const warn = useSettingsStore((state) => state.notifications.tokenExpiry);
  const { meta } = useMeta();
  const { status, tokenState, msLeft } = useFyersAuthStatus();

  if (!warn) return null;
  if (meta?.simulate === true) return null;
  if (!status?.configured) return null;
  if (tokenState !== 'expiring' && tokenState !== 'expired') return null;

  const expired = tokenState === 'expired';
  const message = expired
    ? 'Fyers token has expired'
    : `Fyers token expires in ${formatCountdown(msLeft ?? 0)} — log in again before the market opens`;

  return (
    // <output> is the element with the implicit role "status".
    <output
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-2 text-sm sm:px-6',
        expired
          ? 'border-negative/25 bg-negative/10 text-negative'
          : 'border-warning/25 bg-warning/15 text-warning',
      )}
    >
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 font-medium">{message}</span>
      <Button size="sm" variant="secondary" onClick={startFyersLogin} className="ml-auto h-7">
        <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
        Login with Fyers
        <ExternalLink className="h-3 w-3 opacity-60" aria-hidden="true" />
      </Button>
    </output>
  );
}
