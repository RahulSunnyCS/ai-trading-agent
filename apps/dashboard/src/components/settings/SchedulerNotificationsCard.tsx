'use client';

import { useEffect, useState } from 'react';

import { usePolledResource } from '../../hooks/usePolledResource';
import { apiPut } from '../../lib/api';
import {
  type NotificationRow,
  SCHEDULER_API,
  disabledTypes,
  isProblemType,
  withEnabled,
} from '../../lib/scheduler';
import { Card, CardHeader } from '../ui/Card';
import { RefreshButton } from '../ui/RefreshButton';
import { SkeletonRows } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';
import { toast } from '../ui/Toast';
import { SettingSwitch } from './SettingSwitch';

const URL = `${SCHEDULER_API}/notifications`;

/**
 * Which Telegram alerts are sent. One switch per notification type, bound to the scheduler's
 * `/notifications` endpoint (the same preferences file every sender reads). A switch flips at
 * once and rolls back with a toast if the scheduler refuses the change.
 */
export function SchedulerNotificationsCard() {
  const { data, loading, error, refetch } = usePolledResource<NotificationRow[]>(URL);
  const [rows, setRows] = useState<NotificationRow[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) setRows(data);
  }, [data]);

  async function toggle(type: string, enabled: boolean) {
    if (!rows || saving) return;
    const previous = rows;
    const next = withEnabled(rows, type, enabled);
    setRows(next);
    setSaving(true);
    const result = await apiPut<NotificationRow[]>(URL, { disabled: disabledTypes(next) });
    setSaving(false);
    if (!result.ok) {
      setRows(previous);
      toast(`Could not save: ${result.error}. The switch was put back.`, 'error');
      return;
    }
    setRows(result.data);
    if (!enabled && isProblemType(type)) {
      toast('Failure alerts are off: a broken job will now fail silently.', 'info');
    }
  }

  return (
    <Card>
      <CardHeader
        title="Telegram alerts"
        description="Which messages the scheduler's jobs may send. Scheduler failure and missed-run alerts always send, whatever is switched off here."
        actions={<RefreshButton onClick={refetch} loading={loading} />}
      />
      {!rows ? (
        loading ? (
          <SkeletonRows rows={4} />
        ) : (
          <StateMessage
            variant="error"
            title="Scheduler not reachable"
            description={`Alert settings live in the scheduler (${error ?? 'no response'}). Start the dev stack with "bun run start" (it sets SCHEDULER_DIRECT=1).`}
          />
        )
      ) : (
        <div className="space-y-4">
          {rows.map((row) => (
            <SettingSwitch
              key={row.type}
              label={row.description}
              description={
                !row.enabled && isProblemType(row.type) ? (
                  <span className="text-warning">
                    Off: if this goes wrong you will not hear about it. Failures matter, so consider
                    leaving it on.
                  </span>
                ) : (
                  row.type
                )
              }
              checked={row.enabled}
              disabled={saving}
              onChange={(checked) => void toggle(row.type, checked)}
            />
          ))}
        </div>
      )}
    </Card>
  );
}
