import { AlertTriangle, ExternalLink, LogIn } from 'lucide-react';

import { useDataSource } from '../../hooks/useDataSource';
import { useMeta } from '../../hooks/useMeta';
import { bannerHeadline } from '../../lib/dataSource';
import { startFyersLogin } from '../../lib/fyers-login';
import { Button } from '../ui/Button';

/**
 * Banner under the top bar while recent options data came from the Angel One fallback (no
 * Fyers login was valid that evening). It lists what is missing and carries the Fyers login
 * button: logging in is the repair, applied by the next evening run. Renders nothing in
 * simulation mode, when every recent day came from Fyers, or while the status is unknown.
 */
export function DataSourceBanner() {
  const { meta } = useMeta();
  const { days } = useDataSource();

  if (meta?.simulate === true) return null;
  if (days.length === 0) return null;

  const lines = [...new Set(days.flatMap((d) => d.lines))];

  return (
    <output className="flex flex-wrap items-start gap-x-3 gap-y-1.5 border-b border-warning/25 bg-warning/15 px-4 py-2 text-sm text-warning sm:px-6">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{bannerHeadline(days)}</p>
        {lines.length > 0 && (
          <ul className="mt-0.5 list-disc pl-4 text-xs opacity-90">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        <p className="mt-0.5 text-xs opacity-90">
          Log in to Fyers: contracts that are still listed are re-collected from it on the next run.
        </p>
      </div>
      <Button size="sm" variant="secondary" onClick={startFyersLogin} className="ml-auto h-7">
        <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
        Login with Fyers
        <ExternalLink className="h-3 w-3 opacity-60" aria-hidden="true" />
      </Button>
    </output>
  );
}
