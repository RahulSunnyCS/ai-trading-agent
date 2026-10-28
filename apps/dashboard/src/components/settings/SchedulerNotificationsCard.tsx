'use client';

import { useEffect, useState } from 'react';

import { usePolledResource } from '../../hooks/usePolledResource';
import { apiPut } from '../../lib/api';
import {
  type NotificationLevel,
  type NotificationRow,
  SCHEDULER_API,
  isProblemType,
  levelOfRow,
  levelsBody,
  withLevel,
} from '../../lib/scheduler';
import { Card, CardHeader } from '../ui/Card';
import { RefreshButton } from '../ui/RefreshButton';
import { SegmentedControl } from '../ui/SegmentedControl';
import { SkeletonRows } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';
import { toast } from '../ui/Toast';

const LEVEL_OPTIONS: { value: NotificationLevel; label: string }[] = [
  { value: 'all', label: 'On' },
  { value: 'failures', label: 'Failures only' },
  { value: 'off', label: 'Off' },
];

const URL = `${SCHEDULER_API}/notifications`;

/**
 * Which Telegram alerts are sent. One level per notification type (BL-173: on, failures only,
 * off), bound to the scheduler's `/notifications` endpoint (the same preferences file every
 * sender reads). A change applies at once and rolls back with a toast if the scheduler refuses it.
 */
export function SchedulerNotificationsCard() {
  const { data, loading, error, refetch } = usePolledResource<NotificationRow[]>(URL);
  const [rows, setRows] = useState<NotificationRow[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) setRows(data);
  }, [data]);

  async function change(type: string, level: NotificationLevel) {
    if (!rows || saving) return;
    const previous = rows;
    const next = withLevel(rows, type, level);
    setRows(next);
    setSaving(true);
    const result = await apiPut<NotificationRow[]>(URL, levelsBody(next));
    setSaving(false);
    if (!result.ok) {
      setRows(previous);
      toast(`Could not save: ${result.error}. The switch was put back.`, 'error');
      return;
    }
    setRows(result.data);
    if (level === 'off' && isProblemType(type)) {
      toast('Failure alerts are off: a broken job will now fail silently.', 'info');
    }
  }

  return (
    <Card>
      <CardHeader
        title="Telegram alerts"
        description="Which messages the jobs send. Failures only sends a type's problems (a failed run, something to check) and holds its routine success reports. Messages with no line here always send."
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
          {rows.map((row) => {
            const level = levelOfRow(row);
            return (
              <div
                key={row.type}
                className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground">{row.description}</div>
                  <div className="text-xs text-muted">
                    {level === 'off' && isProblemType(row.type) ? (
                      <span className="text-warning">
                        Off: if this goes wrong you will not hear about it. Failures matter, so
                        consider leaving it on.
                      </span>
                    ) : (
                      row.type
                    )}
                  </div>
                </div>
                <SegmentedControl<NotificationLevel>
                  ariaLabel={`${row.description}: level`}
                  size="sm"
                  value={level}
                  options={LEVEL_OPTIONS}
                  onChange={(next) => void change(row.type, next)}
                />
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
