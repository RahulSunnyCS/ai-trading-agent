'use client';

import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  Loader2,
  RefreshCw,
  Send,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { useMomentumStockSync } from '../../hooks/useMomentumStockSync';
import type { MomentumWeeklyJobState } from '../../hooks/useMomentumWeeklyJob';
import { usePolledResource } from '../../hooks/usePolledResource';
import { apiPost } from '../../lib/api';
import { cn } from '../../lib/cn';
import {
  EMPTY,
  formatDay,
  formatInt,
  formatIstDateTime,
  formatMultiple,
  formatPct,
} from '../../lib/format';
import {
  type BlockSeverity,
  type WeeklyReadiness,
  type WeeklyRunKind,
  actionTone,
  blockSeverity,
  canSend,
  datasetLabel,
  effectiveSend,
  isTradeAction,
  resultStrategies,
  runButtonLabel,
  sendConfirmationText,
  sendDisabledReason,
  signalActionRows,
  sortSignalRows,
  weeklyReadiness,
  weeksBehind,
} from '../../lib/momentumWeekly';
import type {
  MomentumSavedRun,
  MomentumStockActionReview,
  MomentumWeeklyRunResult,
  MomentumWeeklyStatus,
} from '../../types/momentum';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { Input, Select } from '../ui/Input';
import { SegmentedControl, type SegmentedOption } from '../ui/SegmentedControl';
import { StateMessage } from '../ui/StateMessage';
import { toast } from '../ui/Toast';

const RUN_OPTIONS: ReadonlyArray<SegmentedOption<WeeklyRunKind>> = [
  { value: 'preview', label: 'Preview (live prices)' },
  { value: 'final', label: 'Final (official closes)' },
];

function useElapsed(startedAt: string | null, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return startedAt ? Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000)) : 0;
}

/**
 * Manual trigger for the Friday weekly signal (TODO.md 3.11.5) — the same
 * orchestration the launchd-scheduled `mbt weekly` CLI runs. The run executes
 * in the background on the Momentum service, so the user can switch sections or
 * leave the dashboard; the job state lives in the parent (see
 * useMomentumWeeklyJob) so the section tab can show a running indicator too.
 *
 * Order: readiness strip, run controls, the latest run's result, then schedule and data
 * health. Sending to Telegram needs a final run and an explicit confirmation (the rules are
 * in lib/momentumWeekly.ts).
 */
export function MomentumWeeklyView({ weekly }: { weekly: MomentumWeeklyJobState }) {
  const [runKind, setRunKind] = useState<WeeklyRunKind>('final');
  const [send, setSend] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { job, running, startError, start } = weekly;
  const status = usePolledResource<MomentumWeeklyStatus>('/api/momentum/weekly/status');
  const favorites = usePolledResource<MomentumSavedRun[]>('/api/momentum/favorite-strategies');
  const elapsed = useElapsed(job?.started_at ?? null, running);
  const stockSync = useMomentumStockSync();
  const readiness = useMemo(
    () => weeklyReadiness(status.data ?? null, favorites.data ?? null),
    [status.data, favorites.data],
  );
  const sendReason = sendDisabledReason(runKind);
  const willSend = effectiveSend(runKind, send);

  // A finished run may have refreshed prices and saved a signal: re-read the status panel.
  const finishedAt = job?.finished_at ?? null;
  const stockSyncFinishedAt = stockSync.job?.finished_at ?? null;
  const refetchStatus = status.refetch;
  useEffect(() => {
    if (finishedAt || stockSyncFinishedAt) refetchStatus();
  }, [finishedAt, stockSyncFinishedAt, refetchStatus]);

  // Bring the result into view when a run that was seen running here finishes (not on a
  // plain mount with an old result).
  const resultRef = useRef<HTMLDivElement>(null);
  const sawRunning = useRef(false);
  const jobStatus = job?.status ?? null;
  const jobRun = job?.run ?? null;
  useEffect(() => {
    if (running) {
      sawRunning.current = true;
      return;
    }
    if (!sawRunning.current || !jobStatus || jobStatus === 'running') return;
    sawRunning.current = false;
    resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (jobStatus === 'failed') toast(`The ${jobRun ?? 'weekly'} run failed`, 'error');
    else toast(`The ${jobRun ?? 'weekly'} run finished`);
  }, [running, jobStatus, jobRun]);

  function chooseRun(next: WeeklyRunKind): void {
    setRunKind(next);
    setConfirming(false);
    if (!canSend(next)) setSend(false);
  }

  function onRun(): void {
    if (willSend) setConfirming(true);
    else void start(runKind, false);
  }

  function confirmSend(): void {
    setConfirming(false);
    // Re-checked here so a send can only ever leave from this confirmed path.
    if (effectiveSend(runKind, send)) void start(runKind, true);
  }

  const favouriteCount = favorites.data?.length ?? 0;

  return (
    <div className="space-y-5">
      <ReadinessCard
        status={status.data ?? null}
        statusError={status.error}
        favoritesError={favorites.data ? null : favorites.error}
        readiness={readiness}
        stockSync={stockSync}
      />

      <Card>
        <CardHeader
          title="Run the weekly signal"
          description="Manually run the Friday momentum signal — the same job the laptop schedule (14:40 preview / 16:45 final IST) runs automatically."
        />
        <p className="mb-3 text-xs text-muted">
          Preview uses live prices and may change. Final uses official closes for the completed
          week.
          {favorites.data
            ? favouriteCount
              ? ` ${formatInt(favouriteCount)} favourite ${favouriteCount === 1 ? 'strategy' : 'strategies'} will be evaluated.`
              : ' The default live strategy will be evaluated.'
            : ''}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl
            ariaLabel="Run type"
            size="sm"
            value={runKind}
            options={RUN_OPTIONS}
            onChange={chooseRun}
          />
          <label
            className={cn(
              'flex items-center gap-1.5 text-xs',
              sendReason ? 'cursor-not-allowed text-faint' : 'text-muted',
            )}
            title={sendReason ?? undefined}
          >
            <input
              type="checkbox"
              checked={willSend}
              disabled={sendReason !== null || running}
              aria-describedby="weekly-send-note"
              onChange={(event) => {
                setSend(event.target.checked);
                setConfirming(false);
              }}
            />
            Send to Telegram
          </label>
          <Button
            variant="primary"
            size="sm"
            onClick={onRun}
            loading={running}
            disabled={confirming}
            className="ml-auto"
          >
            {running ? null : <Send className="h-3.5 w-3.5" aria-hidden="true" />}
            {running ? 'Running…' : runButtonLabel(runKind, send)}
          </Button>
        </div>
        <p id="weekly-send-note" className="mt-2 text-xs text-muted">
          {sendReason ??
            (willSend
              ? 'You will be asked to confirm before anything is sent.'
              : 'No Telegram message will be sent from this manual run.')}
        </p>

        {confirming && !running ? (
          <fieldset
            aria-label="Confirm sending to Telegram"
            className="mt-3 flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3"
          >
            <p className="min-w-0 flex-1 basis-64 text-sm text-foreground">
              {sendConfirmationText(readiness.activeName, readiness.activeKnown)}
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="primary" onClick={confirmSend}>
                Confirm and send
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </fieldset>
        ) : null}
      </Card>

      <div ref={resultRef} className="scroll-mt-4 space-y-3 empty:hidden">
        {running ? (
          <output
            aria-live="polite"
            className="block rounded-lg border border-primary/30 bg-primary/5 px-4 py-3"
          >
            <div className="flex items-center gap-2.5 text-sm font-medium text-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              Running {job?.run ?? runKind} signal in the background
              <span className="font-normal tabular-nums text-muted">· {elapsed}s</span>
            </div>
            <p className="mt-1 text-xs text-muted">
              You don&apos;t need to stay on this page. Switch sections or close the tab — the run
              keeps going on the Momentum service
              {job?.send ? ', still sends to Telegram when it finishes,' : ''} and the result will
              be here when you come back.
            </p>
          </output>
        ) : null}
        {startError ? (
          <StateMessage variant="error" title="Could not start the run" description={startError} />
        ) : null}
        {!running && job?.status === 'failed' ? (
          <StateMessage
            variant="error"
            title={`The ${job.run} run failed`}
            description={job.error ?? 'Unknown error'}
          />
        ) : null}
        {!running && job?.status === 'done' && job.result ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold tracking-tight text-foreground">
                Latest run result
              </h2>
              <Badge tone="neutral">{job.run === 'final' ? 'Final' : 'Preview'}</Badge>
              {job.result.sent_to_telegram ? (
                <Badge tone="primary" dot>
                  Sent to Telegram
                </Badge>
              ) : (
                <Badge tone="neutral">Not sent</Badge>
              )}
              <span className="text-xs text-muted">
                finished {job.finished_at ? `${formatIstDateTime(job.finished_at)} IST` : EMPTY}
              </span>
            </div>
            <WeeklyResults result={job.result} />
          </>
        ) : null}
      </div>

      <ScheduleCard status={status.data ?? null} />
      <details className="rounded-xl border border-border bg-surface p-4">
        <summary className="cursor-pointer text-sm font-semibold text-foreground">
          Data health · stock action reviews
        </summary>
        <div className="mt-3">
          <StockActionAlerts stockSyncFinishedAt={stockSyncFinishedAt} />
        </div>
      </details>
    </div>
  );
}

function StockActionAlerts({ stockSyncFinishedAt }: { stockSyncFinishedAt: string | null }) {
  const actions = usePolledResource<MomentumStockActionReview>('/api/momentum/stock-actions');
  const refetch = actions.refetch;
  useEffect(() => {
    if (stockSyncFinishedAt) refetch();
  }, [stockSyncFinishedAt, refetch]);

  return (
    <Card>
      <CardHeader
        title="Possible stock splits and bonuses"
        description="After each stock-data refresh, new one-day drops over 20.1% are checked against exchange filings. Unmatched moves need a classification before any share adjustment is applied."
      />
      {actions.error ? (
        <StateMessage
          variant="error"
          title="Could not load stock-action alerts"
          description={actions.error}
        />
      ) : actions.loading && !actions.data ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : actions.data?.items.length ? (
        <div className="space-y-3">
          <p className="text-xs text-muted">
            {actions.data.pending_count} new unresolved move(s) since{' '}
            {formatDay(actions.data.manual_review_after)}. The rounded multiplier comes from volume
            ÷ rupee turnover. It reflects the price change and needs filing evidence before it can
            be treated as a split.
            {actions.data.pending_count > actions.data.items.length
              ? ` Showing the newest ${actions.data.items.length}; more appear as these are resolved.`
              : ''}
          </p>
          {actions.data.items.map((item) => (
            <StockActionAlertRow
              key={`${item.symbol}-${item.ex_date}`}
              item={item}
              onSaved={refetch}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted">
          No new unresolved stock-action alerts since{' '}
          {actions.data ? formatDay(actions.data.manual_review_after) : 'the historical audit'}.
        </p>
      )}
    </Card>
  );
}

function StockActionAlertRow({
  item,
  onSaved,
}: {
  item: MomentumStockActionReview['items'][number];
  onSaved: () => void;
}) {
  const [decision, setDecision] = useState<'' | 'split' | 'bonus' | 'crash'>('');
  const [factor, setFactor] = useState('');
  const [evidence, setEvidence] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dropPct = (1 - item.close / item.previous_close) * 100;
  const volumeRatio = item.previous_volume > 0 ? item.volume / item.previous_volume : null;
  const turnoverRatio = item.previous_turnover > 0 ? item.turnover / item.previous_turnover : null;
  const needsEntitlement =
    item.event_kind != null &&
    ['demerger', 'scheme', 'rights', 'dividend'].includes(item.event_kind);

  async function save() {
    if (!decision) return;
    setSaving(true);
    setError(null);
    const trimmed = evidence.trim();
    const response = await apiPost<{ ok: true }>('/api/momentum/stock-actions/review', {
      symbol: item.symbol,
      ex_date: item.ex_date,
      decision,
      factor: decision === 'crash' ? null : Number(factor),
      source_url: trimmed.startsWith('http') ? trimmed : null,
      note: trimmed && !trimmed.startsWith('http') ? trimmed : null,
    });
    if (response.ok) onSaved();
    else setError(response.error);
    setSaving(false);
  }

  return (
    <div className="rounded-lg border border-border px-3 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-semibold text-foreground">{item.symbol}</span>
        <span className="text-muted">{formatDay(item.ex_date)}</span>
        <Badge tone="warning">Price −{formatPct(dropPct, 1, { unit: 'percent' })}</Badge>
        <span className="text-muted">
          Volume {formatMultiple(volumeRatio)} · turnover {formatMultiple(turnoverRatio)} ·
          price-implied multiple {formatMultiple(item.suggested_factor)}
        </span>
      </div>
      {item.subject ? (
        <p className="mt-1 text-xs text-muted">
          Exchange filing ({item.event_kind ?? 'other action'}): {item.subject}
        </p>
      ) : (
        <p className="mt-1 text-xs text-muted">
          No matching split or bonus filing was found in the cached exchange data.
        </p>
      )}
      {needsEntitlement ? (
        <p className="mt-1 text-xs text-warning">
          This filing needs entitlement or cash payout valuation before the historical return can be
          corrected.
        </p>
      ) : null}
      {!needsEntitlement ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Select
            aria-label={`Classify ${item.symbol} move`}
            value={decision}
            onChange={(event) => setDecision(event.target.value as typeof decision)}
            className="w-auto"
          >
            <option value="">Choose classification</option>
            <option value="split">Split</option>
            <option value="bonus">Bonus</option>
            <option value="crash">Genuine price fall</option>
          </Select>
          {decision === 'split' || decision === 'bonus' ? (
            <Input
              aria-label="New shares per old share"
              type="number"
              min="1.1"
              max="100"
              step="0.1"
              placeholder="New shares / old share"
              value={factor}
              onChange={(event) => setFactor(event.target.value)}
              className="w-44"
            />
          ) : null}
          <Input
            aria-label="Evidence URL or note"
            type="text"
            placeholder="Evidence URL or note"
            value={evidence}
            onChange={(event) => setEvidence(event.target.value)}
            className="w-auto min-w-48 flex-1"
          />
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={
              !decision || saving || (decision !== 'crash' && (!factor || !evidence.trim()))
            }
          >
            {saving ? 'Saving…' : 'Save classification'}
          </Button>
        </div>
      ) : null}
      {error ? <p className="mt-2 text-xs text-negative">{error}</p> : null}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted">{label}</p>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-foreground">
        {children}
      </div>
    </div>
  );
}

/**
 * The one readiness strip: target week, latest final, the Telegram-active strategy, how fresh
 * each dataset is and anything that would block this week's signal.
 */
function ReadinessCard({
  status,
  statusError,
  favoritesError,
  readiness,
  stockSync,
}: {
  status: MomentumWeeklyStatus | null;
  statusError: string | null;
  favoritesError: string | null;
  readiness: WeeklyReadiness;
  stockSync: ReturnType<typeof useMomentumStockSync>;
}) {
  const blocked = readiness.blockedReasons.length > 0;
  return (
    <Card>
      <CardHeader
        title="This week's readiness"
        description="A final run produces the signal for the target week. Each strategy needs its data ingested through that week."
        actions={
          status ? (
            blocked ? (
              <Badge status="attention" dot>
                Needs attention
              </Badge>
            ) : (
              <Badge tone="positive" dot>
                Ready
              </Badge>
            )
          ) : null
        }
      />
      {statusError && !status ? (
        <div className="mb-3">
          <StateMessage
            variant="error"
            title="Could not load data status"
            description={statusError}
          />
        </div>
      ) : null}
      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
        <Fact label="Target week ending">{status ? formatDay(status.target_week) : EMPTY}</Fact>
        <Fact label="Latest final signal">
          {status
            ? readiness.latestFinal
              ? `${formatDay(readiness.latestFinal.week)} · ${readiness.latestFinal.label}`
              : 'None saved yet'
            : EMPTY}
        </Fact>
        <Fact label="Headline favourite">
          {favoritesError ? (
            <span className="text-warning">Couldn&apos;t load favourites</span>
          ) : readiness.activeKnown ? (
            <>
              <span className="truncate">{readiness.activeName ?? 'None selected'}</span>
              {readiness.activeReady === true ? <Badge tone="positive">Data ready</Badge> : null}
              {readiness.activeReady === false ? <Badge status="attention">Blocked</Badge> : null}
            </>
          ) : (
            EMPTY
          )}
        </Fact>
      </div>

      {status ? (
        <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
          {status.datasets.map((item) => (
            <li key={item.key} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2.5">
              <Database className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
              <div className="min-w-0 flex-1 basis-56">
                <div className="text-sm font-medium text-foreground">{item.label}</div>
                <div className={cn('text-xs', item.error ? 'text-warning' : 'text-muted')}>
                  {item.error ?? item.note}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                <span className="text-sm tabular-nums text-foreground">
                  {item.through ? `Through ${formatDay(item.through)}` : 'No data'}
                </span>
                {item.ready ? (
                  <Badge tone="positive" dot>
                    Up to date
                  </Badge>
                ) : (
                  <Badge status="attention" dot>
                    {item.through
                      ? `${formatInt(weeksBehind(item.through, status.target_week))} week(s) behind`
                      : 'Not ingested'}
                  </Badge>
                )}
                {item.key === 'stock' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void stockSync.start()}
                    loading={stockSync.running}
                  >
                    {stockSync.running ? null : (
                      <RefreshCw className="h-3 w-3" aria-hidden="true" />
                    )}
                    {stockSync.running ? 'Refreshing…' : 'Refresh stock data'}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {blocked ? (
        <div className="mt-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3">
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            What would block this week&apos;s signal
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-9 text-sm text-muted">
            {readiness.blockedReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {stockSync.startError ? (
        <div className="mt-3">
          <StateMessage
            variant="error"
            title="Could not start the stock-data refresh"
            description={stockSync.startError}
          />
        </div>
      ) : null}
      {!stockSync.running && stockSync.job?.status === 'failed' ? (
        <div className="mt-3">
          <StateMessage
            variant="error"
            title="Stock-data refresh failed"
            description={stockSync.job.error ?? 'Unknown error'}
          />
        </div>
      ) : null}
    </Card>
  );
}

/** When the scheduled jobs last ran and which signals are saved. Readiness lives in the strip above. */
function ScheduleCard({ status }: { status: MomentumWeeklyStatus | null }) {
  if (!status) return null;
  return (
    <Card>
      <CardHeader
        title="Schedule & saved signals"
        description="The laptop's scheduled runs and the signals they (or a manual final run) have saved."
      />
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">
            Scheduled runs
          </div>
          <ul className="space-y-1.5">
            {status.schedule.map((item) => (
              <li key={item.run} className="flex items-start gap-2 text-sm">
                <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
                <div className="min-w-0">
                  <span className="capitalize text-foreground">{item.run.replace('-', ' ')}</span>{' '}
                  <span className="text-muted">· {item.when}</span>
                  {item.ran_late_by_minutes != null ? (
                    <Badge status="attention" dot className="ml-1.5">
                      ran {formatInt(item.ran_late_by_minutes)}m late
                    </Badge>
                  ) : null}
                  <div className="truncate text-xs text-muted" title={item.last_line ?? ''}>
                    {item.last_ran_at
                      ? `Last ran ${formatIstDateTime(item.last_ran_at)}${item.last_line ? ` — ${item.last_line}` : ''}`
                      : 'Has not run yet on this machine'}
                  </div>
                  {item.ran_late_by_minutes != null ? (
                    <div className="mt-0.5 flex items-center gap-1 text-xs text-warning">
                      <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                      Likely because the laptop was asleep at the scheduled time.
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">
            Saved signals
          </div>
          {status.signals.length === 0 ? (
            <p className="text-sm text-muted">No signal has been saved yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {status.signals.map((item) => (
                <li
                  key={`${item.week}-${item.run}-${item.label}`}
                  className="flex items-start gap-2 text-sm"
                >
                  <CheckCircle2
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-positive"
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <span className="text-foreground">
                      Week of {formatDay(item.week)} · {item.run}
                    </span>
                    <div className="truncate text-xs text-muted">
                      {item.label} · {formatIstDateTime(item.generated_at)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}

const SEVERITY_BORDER: Record<BlockSeverity, string> = {
  info: 'border-border',
  warning: 'border-warning/40',
  blocked: 'border-negative/40',
};

function WeeklyResults({ result }: { result: MomentumWeeklyRunResult }) {
  return (
    <>
      {resultStrategies(result).map((strategy) => {
        const rows = sortSignalRows(signalActionRows(strategy.signal));
        const trades = rows.filter((row) => isTradeAction(row.action)).length;
        const severity = blockSeverity(strategy, result.severity);
        const week = typeof strategy.signal?.week === 'string' ? strategy.signal.week : null;
        return (
          <section
            key={strategy.id ?? strategy.name}
            data-severity={severity}
            className={cn(
              'rounded-xl border bg-surface p-5 shadow-card',
              SEVERITY_BORDER[severity],
            )}
          >
            <div className="mb-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold tracking-tight text-foreground">
                  {strategy.title ?? strategy.name}
                </h3>
                <Badge tone="neutral">{datasetLabel(strategy.dataset)}</Badge>
                {strategy.active ? <Badge tone="primary">Headline</Badge> : null}
                {severity === 'blocked' ? <Badge tone="negative">Blocked</Badge> : null}
              </div>
              <p className="mt-1 text-sm text-muted">
                {strategy.blocked
                  ? `${strategy.name}: ${strategy.blocked}`
                  : strategy.active
                    ? result.sent_to_telegram
                      ? `${strategy.name} is active and was sent to Telegram.`
                      : `${strategy.name} is active; Telegram was not selected.`
                    : `${strategy.name} was evaluated in the dashboard only.`}
              </p>
            </div>
            {!strategy.blocked && strategy.signal ? (
              <div className="space-y-2 text-sm">
                <p className="text-muted">
                  Signal week {formatDay(week)} · {formatInt(trades)} trade
                  {trades === 1 ? '' : 's'} indicated
                </p>
                {rows.length ? (
                  <ul className="flex flex-wrap gap-2">
                    {rows.map((row) => (
                      <li
                        key={`${row.asset}-${row.action}`}
                        className="flex items-center gap-2 rounded-lg border border-border bg-surface-2/40 px-2.5 py-1.5"
                      >
                        <Badge tone={actionTone(row.action)}>{row.action}</Badge>
                        <span className="font-medium text-foreground">{row.asset}</span>
                        {row.rank != null ? (
                          <span className="text-xs text-muted">rank {formatInt(row.rank)}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted">No portfolio changes indicated.</p>
                )}
                {typeof strategy.signal.explain === 'string' ? (
                  <p className="text-muted">{strategy.signal.explain}</p>
                ) : null}
              </div>
            ) : null}
            {strategy.body ? (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-primary">View full notification</summary>
                <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-border bg-surface-2/30 p-3 text-sm text-foreground">
                  {strategy.body}
                </pre>
              </details>
            ) : null}
          </section>
        );
      })}
    </>
  );
}
