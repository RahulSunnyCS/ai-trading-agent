import { AlertTriangle } from 'lucide-react';

import { useMeta } from '../../hooks/useMeta';
import { Badge } from '../ui/Badge';
import { StatusDot } from '../ui/StatusDot';

/**
 * Compact environment + broker-health cluster for the top bar. Renders nothing
 * until the first /api/meta response, then shows a SIM/LIVE pill, the broker
 * name, and an auth-degraded warning when the live feed needs re-login.
 */
export function SystemStatus() {
  const { meta } = useMeta();
  if (!meta) return null;

  return (
    <div className="flex items-center gap-2">
      {meta.authDegraded ? (
        <Badge tone="warning">
          <AlertTriangle className="h-3 w-3" />
          Re-login required
        </Badge>
      ) : null}

      <span className="hidden items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-medium text-muted sm:inline-flex">
        <StatusDot
          tone={meta.simulate ? 'info' : 'positive'}
          pulse={!meta.simulate && !meta.authDegraded}
        />
        {meta.simulate ? 'Simulation' : 'Live'}
        {meta.broker ? <span className="text-faint">· {meta.broker}</span> : null}
      </span>
    </div>
  );
}
