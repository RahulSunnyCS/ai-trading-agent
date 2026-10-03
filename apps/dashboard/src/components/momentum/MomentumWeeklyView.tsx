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
import { useEffect, useState } from 'react';

import { useMomentumStockSync } from '../../hooks/useMomentumStockSync';
import type { MomentumWeeklyJobState } from '../../hooks/useMomentumWeeklyJob';
import { usePolledResource } from '../../hooks/usePolledResource';
import { apiPost } from '../../lib/api';
import { formatIstDateTime } from '../../lib/format';
import type {
  MomentumSavedRun,
  MomentumStockActionReview,
  MomentumWeeklyRunResult,
  MomentumWeeklyStatus,
} from '../../types/momentum';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { StateMessage } from '../ui/StateMessage';

type RunKind = 'preview' | 'final';

const DAY_MS = 86_400_000;

/** "2026-09-25" → "25 Sep 2026", read as a calendar date (no timezone shift). */
function formatDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function weeksBehind(through: string, target: string): number {
  return Math.round((Date.parse(target) - Date.parse(through)) / (7 * DAY_MS));
}

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
 */
export function MomentumWeeklyView({ weekly }: { weekly: MomentumWeeklyJobState }) {
  const [runKind, setRunKind] = useState<RunKind>('final');
  const [send, setSend] = useState(false);
  const { job, running, startError, start } = weekly;
  const status = usePolledResource<MomentumWeeklyStatus>('/api/momentum/weekly/status');
  const favorites = usePolledResource<MomentumSavedRun[]>('/api/momentum/favorite-strategies');
  const elapsed = useElapsed(job?.started_at ?? null, running);
  const stockSync = useMomentumStockSync();
  const active = favorites.data?.find((run) => run.active);
  const latestFinal = status.data?.signals.find((signal) => signal.run === 'final');
  const activeDataKey = active?.config.dataset === 'etf' ? 'etf' : 'stock';
  const activeReady = active
    ? status.data?.datasets.find((item) => item.key === activeDataKey)
    : null;

  // A finished run may have refreshed prices and saved a signal: re-read the status panel.
  const finishedAt = job?.finished_at ?? null;
  const stockSyncFinishedAt = stockSync.job?.finished_at ?? null;
  const refetchStatus = status.refetch;
  useEffect(() => {
    if (finishedAt || stockSyncFinishedAt) refetchStatus();
  }, [finishedAt, stockSyncFinishedAt, refetchStatus]);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="This week's status"
          description={
            status.data
              ? `Target week ending ${formatDay(status.data.target_week)}`
              : 'Checking signal and data status…'
          }
        />
        <div className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <p className="text-xs text-muted">Latest final signal</p>
            <p className="font-medium text-foreground">
              {latestFinal
                ? `${formatDay(latestFinal.week)} · ${latestFinal.label}`
                : 'None saved yet'}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted">Telegram-active strategy</p>
            <p className="font-medium text-foreground">{active?.name ?? 'Default live strategy'}</p>
          </div>
          <div>
            <p className="text-xs text-muted">Readiness</p>
            <p className="font-medium text-foreground">
              {activeReady
                ? activeReady.ready
                  ? 'Data ready'
                  : `Blocked · ${activeReady.note}`
                : active
                  ? 'Checking data…'
                  : 'Check default strategy data below'}
            </p>
          </div>
        </div>
      </Card>
      <Card>
        <CardHeader
          title="Weekly signal"
          description="Manually run the Friday momentum signal — the same job the laptop schedule (14:40 preview / 16:45 final IST) runs automatically."
        />
        <p className="mb-3 text-xs text-muted">
          Preview uses live prices and may change. Final uses official closes for the completed
          week.
          {favorites.data?.length
            ? ` ${favorites.data.length} favourite strategies will be evaluated.`
            : ' The default live strategy will be evaluated.'}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-lg border border-border bg-surface-2/30 p-1">
            <Button
              size="sm"
              variant={runKind === 'preview' ? 'primary' : 'ghost'}
              onClick={() => setRunKind('preview')}
            >
              Preview (live prices)
            </Button>
            <Button
              size="sm"
              variant={runKind === 'final' ? 'primary' : 'ghost'}
              onClick={() => setRunKind('final')}
            >
              Final (official closes)
            </Button>
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={send}
              onChange={(event) => setSend(event.target.checked)}
            />
            Send to Telegram
          </label>
          <Button
            size="sm"
            onClick={() => void start(runKind, send)}
            disabled={running}
            className="ml-auto"
          >
            <Send className={running ? 'h-3.5 w-3.5 animate-pulse' : 'h-3.5 w-3.5'} />
            {running ? 'Running…' : send ? 'Run and send to Telegram' : 'Run without sending'}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted">
          {send
            ? `Telegram will receive the result for ${active?.name ?? 'the default live strategy'}.`
            : 'No Telegram message will be sent from this manual run.'}
        </p>

        {running ? (
          <output
            aria-live="polite"
            className="mt-4 block rounded-lg border border-primary/30 bg-primary/5 px-4 py-3"
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
          <div className="mt-4">
            <StateMessage
              variant="error"
              title="Could not start the run"
              description={startError}
            />
          </div>
        ) : null}
        {!running && job?.status === 'failed' ? (
          <div className="mt-4">
            <StateMessage
              variant="error"
              title={`The ${job.run} run failed`}
              description={job.error ?? 'Unknown error'}
            />
          </div>
        ) : null}
      </Card>

      <IngestionStatusCard
        status={status.data}
        error={status.error}
        loading={status.loading}
        stockSync={stockSync}
      />
      <details className="rounded-xl border border-border bg-surface p-4">
        <summary className="cursor-pointer text-sm font-semibold text-foreground">
          Data health · stock action reviews
        </summary>
        <div className="mt-3">
          <StockActionAlerts stockSyncFinishedAt={stockSyncFinishedAt} />
        </div>
      </details>

      {!running && job?.status === 'done' && job.result ? (
        <div className="space-y-3">
          <p className="text-xs text-muted">
            Last manual {job.run} run finished{' '}
            {job.finished_at ? formatIstDateTime(job.finished_at) : ''} IST
          </p>
          <WeeklyResults result={job.result} />
        </div>
      ) : null}
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
        <Badge tone="warning">Price −{dropPct.toFixed(1)}%</Badge>
        <span className="text-muted">
          Volume {volumeRatio?.toFixed(1) ?? '—'}× · turnover {turnoverRatio?.toFixed(1) ?? '—'}× ·
          price-implied multiple {item.suggested_factor?.toFixed(1) ?? '—'}×
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
          <select
            aria-label={`Classify ${item.symbol} move`}
            value={decision}
            onChange={(event) => setDecision(event.target.value as typeof decision)}
            className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
          >
            <option value="">Choose classification</option>
            <option value="split">Split</option>
            <option value="bonus">Bonus</option>
            <option value="crash">Genuine price fall</option>
          </select>
          {decision === 'split' || decision === 'bonus' ? (
            <input
              aria-label="New shares per old share"
              type="number"
              min="1.1"
              max="100"
              step="0.1"
              placeholder="New shares / old share"
              value={factor}
              onChange={(event) => setFactor(event.target.value)}
              className="w-44 rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
            />
          ) : null}
          <input
            aria-label="Evidence URL or note"
            type="text"
            placeholder="Evidence URL or note"
            value={evidence}
            onChange={(event) => setEvidence(event.target.value)}
            className="min-w-48 flex-1 rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
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
      {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
    </div>
  );
}

function IngestionStatusCard({
  status,
  error,
  loading,
  stockSync,
}: {
  status: MomentumWeeklyStatus | null;
  error: string | null;
  loading: boolean;
  stockSync: ReturnType<typeof useMomentumStockSync>;
}) {
  return (
    <Card>
      <CardHeader
        title="Data & schedule"
        description={
          status
            ? `A final run produces the signal for the week ending ${formatDay(status.target_week)}. Each strategy needs its data ingested through that week.`
            : 'How far each data source has been ingested.'
        }
      />
      {stockSync.startError ? (
        <div className="mb-3">
          <StateMessage
            variant="error"
            title="Could not start the stock-data refresh"
            description={stockSync.startError}
          />
        </div>
      ) : null}
      {!stockSync.running && stockSync.job?.status === 'failed' ? (
        <div className="mb-3">
          <StateMessage
            variant="error"
            title="Stock-data refresh failed"
            description={stockSync.job.error ?? 'Unknown error'}
          />
        </div>
      ) : null}
      {error && !status ? (
        <StateMessage variant="error" title="Could not load data status" description={error} />
      ) : !status ? (
        <p className="text-sm text-muted">{loading ? 'Loading…' : 'No status yet.'}</p>
      ) : (
        <div className="space-y-4">
          <ul className="divide-y divide-border rounded-lg border border-border">
            {status.datasets.map((item) => (
              <li key={item.key} className="flex flex-wrap items-start gap-3 px-3 py-2.5">
                <Database className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-foreground">{item.label}</div>
                  <div className="text-xs text-muted">{item.error ?? item.note}</div>
                </div>
                <div className="text-right">
                  <div className="text-sm tabular-nums text-foreground">
                    {item.through ? `Data through ${formatDay(item.through)}` : 'No data'}
                  </div>
                  {item.ready ? (
                    <Badge tone="positive" dot>
                      Up to date
                    </Badge>
                  ) : (
                    <Badge tone="warning" dot>
                      {item.through
                        ? `${weeksBehind(item.through, status.target_week)} week(s) behind`
                        : 'Not ingested'}
                    </Badge>
                  )}
                  {item.key === 'stock' ? (
                    <div className="mt-1.5">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void stockSync.start()}
                        disabled={stockSync.running}
                      >
                        <RefreshCw
                          className={stockSync.running ? 'h-3 w-3 animate-spin' : 'h-3 w-3'}
                        />
                        {stockSync.running ? 'Refreshing…' : 'Refresh stock data'}
                      </Button>
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>

          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">
                Scheduled runs
              </div>
              <ul className="space-y-1.5">
                {status.schedule.map((item) => (
                  <li key={item.run} className="flex items-start gap-2 text-sm">
                    <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
                    <div className="min-w-0">
                      <span className="capitalize text-foreground">
                        {item.run.replace('-', ' ')}
                      </span>{' '}
                      <span className="text-muted">· {item.when}</span>
                      {item.ran_late_by_minutes != null ? (
                        <Badge tone="warning" dot className="ml-1.5">
                          ran {item.ran_late_by_minutes}m late
                        </Badge>
                      ) : null}
                      <div className="truncate text-xs text-muted" title={item.last_line ?? ''}>
                        {item.last_ran_at
                          ? `Last ran ${formatIstDateTime(item.last_ran_at)}${item.last_line ? ` — ${item.last_line}` : ''}`
                          : 'Has not run yet on this machine'}
                      </div>
                      {item.ran_late_by_minutes != null ? (
                        <div className="mt-0.5 flex items-center gap-1 text-xs text-warning">
                          <AlertTriangle className="h-3 w-3" />
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
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-positive" />
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
        </div>
      )}
    </Card>
  );
}

function WeeklyResults({ result }: { result: MomentumWeeklyRunResult }) {
  const strategies = result.strategies ?? [
    {
      id: null,
      name: 'Default live strategy',
      dataset: 'etf' as const,
      active: true,
      blocked: null,
      title: result.title,
      body: result.body,
      signal: result.signal,
    },
  ];
  return (
    <>
      {strategies.map((strategy) => {
        const rawRows = strategy.signal?.rows;
        const rows = Array.isArray(rawRows)
          ? rawRows.filter(
              (row): row is { asset: string; action: string; rank?: number | null } =>
                typeof row === 'object' &&
                row !== null &&
                typeof row.asset === 'string' &&
                typeof row.action === 'string',
            )
          : [];
        const actions = rows.filter((row) => row.action.trim());
        return (
          <Card key={strategy.id ?? strategy.name}>
            <CardHeader
              title={strategy.title ?? strategy.name}
              description={
                strategy.blocked
                  ? `${strategy.name}: ${strategy.blocked}`
                  : strategy.active
                    ? result.sent_to_telegram
                      ? `${strategy.name} is active and was sent to Telegram.`
                      : `${strategy.name} is active; Telegram was not selected.`
                    : `${strategy.name} was evaluated in the dashboard only.`
              }
            />
            {strategy.blocked ? (
              <Badge tone="warning">Blocked</Badge>
            ) : strategy.signal ? (
              <div className="space-y-2 text-sm">
                <p className="text-muted">
                  Signal week {String(strategy.signal.week ?? '—')} · {actions.length} indicated
                  action{actions.length === 1 ? '' : 's'}
                </p>
                {actions.length ? (
                  <ul className="flex flex-wrap gap-2">
                    {actions.map((row) => (
                      <li
                        key={`${row.asset}-${row.action}`}
                        className="rounded-lg border border-border bg-surface-2/40 px-3 py-2"
                      >
                        <span className="font-medium text-foreground">
                          {row.action} {row.asset}
                        </span>
                        {row.rank != null ? (
                          <span className="ml-1 text-xs text-muted">rank {row.rank}</span>
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
          </Card>
        );
      })}
    </>
  );
}
