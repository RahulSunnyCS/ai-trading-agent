/**
 * JobsView — Data › Jobs: the scheduler's jobs (apps/scheduler), their next and latest run,
 * a Run now button, and the tail of a job's latest log. Reads the scheduler's loopback API
 * through `/api/scheduler/*`.
 */

import { PlayCircle } from 'lucide-react';
import { useState } from 'react';

import { useRunLog, useSchedulerJobs } from '../hooks/useSchedulerJobs';
import { apiPost } from '../lib/api';
import { EMPTY, formatDuration, formatIstDateTimeShort, formatRelative } from '../lib/format';
import {
  RUN_STATUS_LABEL,
  SCHEDULER_API,
  type SchedulerJob,
  needsConfirmation,
  runDurationMs,
  runNowError,
  runStatus,
} from '../lib/scheduler';
import { ConfirmDialog, type ConfirmRequest } from './optionslab/builder/ConfirmDialog';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  RefreshButton,
  SkeletonRows,
  StateMessage,
  THead,
  TRow,
  Table,
  Td,
  Th,
  toast,
} from './ui';

function LogPanel({ job, runId }: { job: SchedulerJob; runId: number }) {
  const running = runStatus(job.lastRun) === 'running';
  const log = useRunLog(runId, running);
  return (
    <Card className="space-y-3">
      <CardHeader
        title={`Latest log: ${job.id}`}
        description={`Run #${runId}, last 200 lines`}
        actions={<RefreshButton onClick={log.refetch} loading={log.loading} />}
      />
      {log.error && !log.data ? (
        <StateMessage variant="error" title="No log available" description={log.error} />
      ) : (
        <pre
          aria-label={`Log of ${job.id}`}
          className="max-h-96 overflow-auto rounded-lg border border-border bg-surface-2/70 p-3 font-mono text-xs text-foreground"
        >
          {log.data ? log.data.text || '(empty log)' : 'Loading…'}
        </pre>
      )}
    </Card>
  );
}

export function JobsView() {
  const { data, loading, error, refetch } = useSchedulerJobs();
  const [selected, setSelected] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  async function start(job: SchedulerJob) {
    setStarting(job.id);
    const result = await apiPost<{ runId: number | null }>(
      `${SCHEDULER_API}/jobs/${encodeURIComponent(job.id)}/run`,
      {},
    );
    setStarting(null);
    if (!result.ok) {
      toast(runNowError(result.status, result.error), 'error');
      return;
    }
    toast(`Started ${job.id}${result.data.runId ? ` (run #${result.data.runId})` : ''}`);
    setSelected(job.id);
    refetch();
  }

  function runNow(job: SchedulerJob) {
    if (!needsConfirmation(job)) {
      void start(job);
      return;
    }
    setConfirm({
      title: `Run ${job.id} now?`,
      body: `This job needs the owner's laptop (${job.needs
        .filter((need) => need !== 'postgres')
        .join(
          ' and ',
        )}): a residential connection or a browser window may be used. Run it only if you are at the machine.`,
      confirmLabel: 'Run now',
      onConfirm: () => void start(job),
    });
  }

  if (!data) {
    if (loading) return <SkeletonRows rows={5} />;
    return (
      <StateMessage
        variant="error"
        title="Scheduler not reachable"
        description={`The dashboard could not reach the scheduler's API (${error ?? 'no response'}). Start the dev stack with "bun run start" (it sets SCHEDULER_DIRECT=1) and make sure the scheduler is running.`}
      />
    );
  }

  const focus = data.find((job) => job.id === selected) ?? null;

  return (
    <div className="space-y-5">
      <Card flush>
        <div className="px-5 pt-5">
          <CardHeader
            title="Scheduled jobs"
            description="Times are IST. Click a job to read its latest log."
            actions={<RefreshButton onClick={refetch} loading={loading} />}
          />
        </div>
        {error ? (
          <div className="px-5 pb-3">
            <StateMessage variant="error" title="Showing the last response" description={error} />
          </div>
        ) : null}
        {data.length === 0 ? (
          <StateMessage variant="empty" title="No jobs registered" />
        ) : (
          <Table>
            <THead>
              <Th>Job</Th>
              <Th>Schedule</Th>
              <Th>Next run</Th>
              <Th>Last run</Th>
              <Th>Group</Th>
              <Th>Needs</Th>
              <Th align="right">Action</Th>
            </THead>
            <tbody>
              {data.map((job) => {
                const status = runStatus(job.lastRun);
                const duration = runDurationMs(job.lastRun);
                return (
                  <TRow
                    key={job.id}
                    selected={job.id === selected}
                    onClick={() => setSelected(job.id)}
                  >
                    <Td>
                      <div className="font-medium">{job.id}</div>
                      <div className="max-w-xs text-xs text-muted">{job.description}</div>
                    </Td>
                    <Td className="whitespace-nowrap text-muted">{job.schedule}</Td>
                    <Td className="whitespace-nowrap">{formatIstDateTimeShort(job.nextRun)}</Td>
                    <Td className="whitespace-nowrap">
                      {status && job.lastRun ? (
                        <div className="flex flex-col items-start gap-0.5">
                          <Badge status={status} dot>
                            {RUN_STATUS_LABEL[status] ?? status}
                          </Badge>
                          <span className="text-xs text-muted">
                            {formatRelative(job.lastRun.started_at)}
                            {duration !== null ? ` · ${formatDuration(duration)}` : ''}
                          </span>
                        </div>
                      ) : (
                        EMPTY
                      )}
                    </Td>
                    <Td className="text-muted">{job.group ?? EMPTY}</Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {job.needs.length === 0
                          ? EMPTY
                          : job.needs.map((need) => (
                              <Badge key={need} tone="neutral">
                                {need}
                              </Badge>
                            ))}
                      </div>
                    </Td>
                    <Td align="right">
                      <Button
                        size="sm"
                        loading={starting === job.id}
                        disabled={starting !== null || status === 'running'}
                        onClick={(event) => {
                          event.stopPropagation();
                          runNow(job);
                        }}
                        aria-label={`Run ${job.id} now`}
                      >
                        <PlayCircle className="h-3.5 w-3.5" />
                        Run now
                      </Button>
                    </Td>
                  </TRow>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      {focus ? (
        focus.lastRun ? (
          <LogPanel key={focus.lastRun.id} job={focus} runId={focus.lastRun.id} />
        ) : (
          <StateMessage variant="empty" title={`${focus.id} has not run yet`} />
        )
      ) : null}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
