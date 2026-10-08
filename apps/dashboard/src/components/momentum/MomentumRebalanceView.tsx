'use client';

import { ClipboardPaste, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { apiGet, apiPost } from '../../lib/api';
import { cn } from '../../lib/cn';
import {
  EMPTY,
  formatDay,
  formatInr,
  formatInt,
  formatIstDateTimeShort,
  formatPct,
  formatPp,
  istToday,
} from '../../lib/format';
import { describeConfig } from '../../lib/momentumConfig';
import {
  type HoldingDraft,
  type PasteResult,
  type RebalanceAction,
  type RebalanceTableRow,
  buildRebalanceTable,
  parseHoldingsPaste,
  previewBlocker,
  targetAsHoldings,
  toDrafts,
  validateHoldings,
} from '../../lib/momentumRebalance';
import type { MomentumRebalanceResult, MomentumSavedRun } from '../../types/momentum';
import { Badge, type Tone } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { Input, Select, inputClass } from '../ui/Input';
import { SegmentedControl, type SegmentedOption } from '../ui/SegmentedControl';
import { StateMessage } from '../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { toast } from '../ui/Toast';

type Dataset = 'stock' | 'broad';

interface PreviewJob {
  id: string;
  status: 'running' | 'done' | 'failed';
  result: MomentumRebalanceResult | null;
  error: string | null;
}

const PREVIEW_POLL_MS = 2000;

/**
 * Start the preview as a background job and poll it. A synchronous request is cut off with an
 * HTTP 524 by Cloudflare after ~100 s, and a Broad preview on a cold cache can take longer.
 */
async function runPreviewJob(
  body: Record<string, unknown>,
): Promise<{ ok: true; data: MomentumRebalanceResult } | { ok: false; error: string }> {
  const started = await apiPost<PreviewJob>('/api/momentum/rebalance-preview/jobs', body);
  if (!started.ok) return { ok: false, error: started.error };
  const id = started.data.id;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, PREVIEW_POLL_MS));
    const polled = await apiGet<PreviewJob>(`/api/momentum/rebalance-preview/jobs/${id}`);
    if (!polled.ok) return { ok: false, error: polled.error };
    if (polled.data.status === 'done' && polled.data.result) {
      return { ok: true, data: polled.data.result };
    }
    if (polled.data.status === 'failed') {
      return { ok: false, error: polled.data.error ?? 'The preview failed.' };
    }
  }
}
// The rebalance-preview API accepts only these two datasets (it answers 422 for ETF Rotation
// and Custom Index). Broad Momentum is the one the Momentum section shows; the Nifty 50 stock
// dataset is hidden from the Backtest tab but still has saved runs, so it is named as such.
const DATASET_LABEL: Record<Dataset, string> = {
  broad: 'Broad Momentum',
  stock: 'Nifty 50 stock dataset',
};
const DATASET_OPTIONS: ReadonlyArray<SegmentedOption<Dataset>> = [
  { value: 'broad', label: DATASET_LABEL.broad },
  { value: 'stock', label: DATASET_LABEL.stock },
];
const ACTION_TONE: Record<RebalanceAction, Tone> = {
  BUY: 'positive',
  SELL: 'negative',
  HOLD: 'neutral',
};

type Holding = HoldingDraft & { id: number };
type Meta = {
  defaults: Record<string, unknown>;
  instruments: Array<{
    name: string;
    display_name?: string | null;
    has_data: boolean;
    include: string;
  }>;
  last_week: string;
};
type Scores = { stocks: Array<{ symbol: string; company_name: string }> };

function displayDate(value: string | null): string {
  return value ? formatDay(value) : 'none yet';
}

function cadenceLabel(schedule: MomentumRebalanceResult['rebalance_schedule']): string {
  if (!schedule) return 'Unknown cadence';
  if (schedule.cadence === 'monthly') return 'Monthly';
  return schedule.interval_weeks === 1
    ? 'Every week'
    : `Every ${schedule.interval_weeks ?? EMPTY} weeks`;
}

function pct(value: number): string {
  return formatPct(value, 2, { unit: 'percent' });
}

export function MomentumRebalanceView({
  currentBroadConfig,
}: {
  currentBroadConfig: Record<string, unknown> | null;
}) {
  const [dataset, setDataset] = useState<Dataset>('broad');
  const [choice, setChoice] = useState('default');
  const [runs, setRuns] = useState<MomentumSavedRun[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Array<{ value: string; label: string }>>([]);
  const [holdings, setHoldings] = useState<Holding[]>([{ id: 0, asset: '', percent: '' }]);
  const [nextId, setNextId] = useState(1);
  const [portfolioValue, setPortfolioValue] = useState('100000');
  const [strategyStartDate, setStrategyStartDate] = useState(() => istToday());
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<MomentumRebalanceResult | null>(null);
  // The last previewed model target for the current dataset and strategy choice. Kept after
  // the result is cleared by an edit, so it can still prefill the holdings.
  const [previewedTarget, setPreviewedTarget] = useState<{
    week: string;
    drafts: HoldingDraft[];
  } | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteReport, setPasteReport] = useState<PasteResult | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    setChoice('default');
    setPlan(null);
    setPreviewedTarget(null);
    void Promise.all([
      apiGet<MomentumSavedRun[]>(`/api/momentum/saved-runs?dataset=${dataset}`),
      apiGet<Meta>(`/api/momentum/meta?dataset=${dataset}`),
      dataset === 'broad' ? apiGet<Scores>('/api/momentum/scores') : Promise.resolve(null),
    ]).then(([saved, metadata, scores]) => {
      if (!alive) return;
      // A favourite group (BL-051) has no config of its own to preview.
      setRuns(saved.ok ? saved.data.filter((run) => !run.group) : []);
      setMeta(metadata.ok ? metadata.data : null);
      setSuggestions(
        dataset === 'broad'
          ? scores?.ok
            ? scores.data.stocks.map((item) => ({ value: item.symbol, label: item.company_name }))
            : []
          : metadata.ok
            ? metadata.data.instruments
                .filter((item) => item.has_data)
                .map((item) => ({ value: item.name, label: item.display_name ?? item.name }))
            : [],
      );
      setLoadError(!metadata.ok ? metadata.error : !saved.ok ? saved.error : null);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [dataset]);

  const selectedRun = runs.find((run) => run.id === choice);
  const config = useMemo(() => {
    if (choice === 'current') return currentBroadConfig;
    if (selectedRun) return selectedRun.config;
    if (!meta) return null;
    return {
      ...meta.defaults,
      dataset,
      universe:
        dataset === 'broad'
          ? ['broad_momentum']
          : meta.instruments
              .filter((item) => item.has_data && item.include !== 'optional')
              .map((item) => item.name),
    };
  }, [choice, currentBroadConfig, dataset, meta, selectedRun]);
  const described = useMemo(
    () => (config ? describeConfig(config, dataset) : null),
    [config, dataset],
  );
  const validation = useMemo(() => validateHoldings(holdings), [holdings]);
  const allocated = validation.allocated;
  const cash = 100 - allocated;
  const over = cash < -0.0001;
  const blocker = previewBlocker({
    loading,
    hasConfig: config !== null,
    holdingsError: validation.error,
    portfolioValue,
    strategyStartDate,
  });
  const knownAssets = useMemo(() => suggestions.map((item) => item.value), [suggestions]);
  const pasted = useMemo(
    () => (pasteText.trim() ? parseHoldingsPaste(pasteText, knownAssets) : null),
    [pasteText, knownAssets],
  );
  const table = useMemo(() => (plan ? buildRebalanceTable(plan) : null), [plan]);

  function updateHolding(id: number, patch: Partial<HoldingDraft>) {
    setHoldings((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    setPlan(null);
  }

  /** Swap the whole list (paste, prefill, dataset change); an empty list leaves one blank row. */
  function replaceHoldings(drafts: readonly HoldingDraft[]) {
    const next = drafts.length ? drafts : [{ asset: '', percent: '' }];
    setHoldings(next.map((draft, index) => ({ ...draft, id: nextId + index })));
    setNextId((id) => id + next.length);
    setPlan(null);
  }

  function chooseDataset(next: Dataset) {
    if (next === dataset) return;
    setDataset(next);
    replaceHoldings([]);
    setPasteReport(null);
  }

  function applyPaste() {
    if (!pasted || pasted.holdings.length === 0) return;
    replaceHoldings(toDrafts(pasted.holdings));
    setPasteReport(pasted);
    setPasteOpen(false);
    setPasteText('');
    toast(
      `Loaded ${formatInt(pasted.holdings.length)} holding${pasted.holdings.length === 1 ? '' : 's'} from the paste`,
      pasted.errors.length || pasted.overAllocated ? 'info' : 'success',
    );
  }

  function applyPreviewedTarget() {
    if (!previewedTarget) return;
    replaceHoldings(previewedTarget.drafts);
    setPasteReport(null);
    toast('Holdings replaced with the previewed model target');
  }

  async function preview(): Promise<void> {
    if (blocker || !config) return;
    setError(null);
    setPlan(null);
    setRunning(true);
    const response = await runPreviewJob({
      ...config,
      holdings_pct: validation.holdings,
      portfolio_value: Number(portfolioValue),
      strategy_start_date: strategyStartDate,
      auth_source: 'dashboard',
    });
    if (!response.ok) setError(response.error);
    else {
      setPlan(response.data);
      setPreviewedTarget({
        week: response.data.signal_week,
        drafts: targetAsHoldings(response.data),
      });
    }
    setRunning(false);
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Rebalance preview"
          description="Compare your actual holdings with the model target at any time. Market hours use live Fyers prices; otherwise the preview uses the latest database close. It never places orders."
        />
        <SegmentedControl
          ariaLabel="Rebalance dataset"
          size="sm"
          value={dataset}
          options={DATASET_OPTIONS}
          onChange={chooseDataset}
        />
        <p className="mt-2 text-xs text-muted">
          ETF Rotation is not offered here: the rebalance preview only supports the two stock
          datasets. The Nifty 50 stock dataset is hidden from the Backtest tab, but its saved
          strategies can still be previewed.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <label htmlFor="rebalance-strategy" className="text-xs font-medium text-muted">
            Strategy settings
            <Select
              id="rebalance-strategy"
              className="mt-1 block"
              value={choice}
              onChange={(event) => {
                setChoice(event.target.value);
                setPlan(null);
                setPreviewedTarget(null);
              }}
              disabled={loading}
            >
              <option value="default">Default {DATASET_LABEL[dataset]} settings</option>
              {dataset === 'broad' && currentBroadConfig ? (
                <option value="current">Current Backtest settings</option>
              ) : null}
              {runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.name}
                  {run.active ? ' · headline' : ''}
                </option>
              ))}
            </Select>
          </label>
          <p className="text-xs text-muted">Data through {formatDay(meta?.last_week)}</p>
        </div>
        {config && described ? (
          <p className="mt-3 rounded-lg bg-surface-2/50 px-3 py-2 text-xs text-muted">
            {described.period}
            {' · '}
            {described.cadence} rebalancing
            {' · '}
            {described.selection}
            {' · '}benchmark {described.benchmark}
          </p>
        ) : null}
        <p className="mt-3 text-xs text-muted">
          Live prices are used during NSE market hours (09:15–15:30 IST). Outside market hours, or
          when live quotes are unavailable, the result is clearly marked as an as-of preview.
        </p>
        {loadError ? (
          <div className="mt-3">
            <StateMessage
              variant="error"
              title="Could not load strategy choices"
              description={loadError}
            />
          </div>
        ) : null}
      </Card>
      <Card>
        <CardHeader
          title="Current portfolio"
          description="Enter what you hold now, or paste it. Any unallocated percentage is treated as cash."
        />
        <datalist id="rebalance-assets">
          {suggestions.map((item) => (
            <option key={item.value} value={item.value} label={item.label} />
          ))}
        </datalist>
        <div className="space-y-2">
          {holdings.map((row, index) => (
            <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_6rem_auto] items-end gap-2">
              <label htmlFor={`rebalance-asset-${row.id}`} className="text-xs text-muted">
                Asset {index + 1}
                <Input
                  id={`rebalance-asset-${row.id}`}
                  list="rebalance-assets"
                  value={row.asset}
                  onChange={(event) => updateHolding(row.id, { asset: event.target.value })}
                  placeholder={dataset === 'broad' ? 'RELIANCE' : 'Company ID or Gold'}
                  className="mt-1"
                />
              </label>
              <label htmlFor={`rebalance-weight-${row.id}`} className="text-xs text-muted">
                Weight %
                <Input
                  id={`rebalance-weight-${row.id}`}
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={row.percent}
                  onChange={(event) => updateHolding(row.id, { percent: event.target.value })}
                  className="mt-1"
                />
              </label>
              <Button
                size="icon"
                aria-label={`Remove holding ${index + 1}`}
                onClick={() => {
                  setHoldings((rows) => rows.filter((item) => item.id !== row.id));
                  setPlan(null);
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => {
              setHoldings((rows) => [...rows, { id: nextId, asset: '', percent: '' }]);
              setNextId((id) => id + 1);
            }}
          >
            <Plus className="h-3.5 w-3.5" /> Add holding
          </Button>
          <Button
            size="sm"
            aria-expanded={pasteOpen}
            aria-controls="rebalance-paste"
            onClick={() => setPasteOpen((open) => !open)}
          >
            <ClipboardPaste className="h-3.5 w-3.5" /> Paste holdings
          </Button>
          {previewedTarget ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={applyPreviewedTarget}
              title={`The model target from the preview for signal week ${formatDay(previewedTarget.week)}`}
            >
              Use the previewed target as my holdings
            </Button>
          ) : null}
        </div>
        {pasteOpen ? (
          <div
            id="rebalance-paste"
            className="mt-3 rounded-lg border border-border bg-surface-2/30 p-3"
          >
            <label className="text-xs text-muted">
              One holding per line: a symbol and a percentage. Two columns copied from a spreadsheet
              work, as do “RELIANCE 12.5”, “RELIANCE,12.5” and “RELIANCE 12.5%”.
              <textarea
                aria-label="Holdings to paste"
                rows={6}
                value={pasteText}
                onChange={(event) => setPasteText(event.target.value)}
                placeholder={'RELIANCE\t12.5\nTCS, 10\nINFY 7.5%'}
                className={cn(inputClass, 'mt-1 font-mono')}
              />
            </label>
            {pasted ? <PasteSummary result={pasted} /> : null}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="primary"
                disabled={!pasted || pasted.holdings.length === 0}
                onClick={applyPaste}
              >
                Replace holdings with these
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPasteOpen(false)}>
                Cancel
              </Button>
              <span className="text-xs text-muted">
                Replaces the rows above. The same symbol on several lines is added together.
              </span>
            </div>
          </div>
        ) : pasteReport && (pasteReport.errors.length > 0 || pasteReport.merged.length > 0) ? (
          <div className="mt-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
            <p className="text-xs font-medium text-foreground">From the last paste</p>
            <PasteSummary result={pasteReport} totals={false} />
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-sm">
          <span className={over ? 'text-negative' : 'text-muted'}>Allocated {pct(allocated)}</span>
          <span className={over ? 'text-negative' : 'text-muted'}>Cash remainder {pct(cash)}</span>
        </div>
        {allocated <= 0.0001 ? (
          <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
            <p className="text-sm font-medium text-foreground">First allocation</p>
            <p className="mt-0.5 text-sm text-muted">
              No invested allocation is entered, so the portfolio is treated as 100% cash and this
              preview is labelled as your first allocation.
            </p>
          </div>
        ) : null}
        <div className="mt-4 grid max-w-2xl gap-3 sm:grid-cols-2">
          <label htmlFor="rebalance-capital" className="text-xs text-muted">
            Total portfolio value (₹)
            <Input
              id="rebalance-capital"
              type="number"
              min="0.01"
              step="0.01"
              value={portfolioValue}
              onChange={(event) => {
                setPortfolioValue(event.target.value);
                setPlan(null);
              }}
              className="mt-1"
            />
          </label>
          <label htmlFor="rebalance-start" className="text-xs text-muted">
            Strategy live start date
            <Input
              id="rebalance-start"
              type="date"
              required
              value={strategyStartDate}
              onChange={(event) => {
                setStrategyStartDate(event.target.value);
                setPlan(null);
              }}
              className="mt-1"
            />
            <span className="mt-1 block">
              Anchors which Friday is week 1 for an every-2, every-3 or every-4-week strategy.
            </span>
          </label>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button
            variant="primary"
            loading={running}
            disabled={blocker !== null}
            aria-describedby={blocker ? 'rebalance-preview-blocker' : undefined}
            onClick={() => void preview()}
          >
            {running ? 'Computing preview…' : 'Preview rebalance'}
          </Button>
          {blocker ? (
            <output id="rebalance-preview-blocker" className="text-sm text-warning">
              {blocker}
            </output>
          ) : (
            <p className="text-xs text-muted">Read-only: no orders are placed.</p>
          )}
        </div>
        {error ? (
          <div className="mt-3">
            <StateMessage
              variant="error"
              title="Rebalance preview unavailable"
              description={error}
            />
          </div>
        ) : null}
      </Card>
      {plan && table ? (
        <Card>
          <CardHeader
            title="Indicative changes"
            description={`${plan.price_source} · ${
              plan.price_mode === 'live'
                ? `${formatIstDateTimeShort(plan.as_of, { seconds: true })} IST`
                : `as of ${formatDay(plan.as_of)}`
            } · Signal week ${formatDay(plan.signal_week)}`}
          />
          {plan.rebalance_schedule ? (
            <div
              className={`mb-4 rounded-lg border px-4 py-3 ${
                plan.rebalance_schedule.is_rebalance_week
                  ? 'border-positive/30 bg-positive/5'
                  : 'border-warning/30 bg-warning/10'
              }`}
            >
              <p className="text-sm font-medium text-foreground">
                {plan.first_allocation ? 'First allocation · ' : ''}
                {plan.rebalance_schedule.is_rebalance_week
                  ? 'Rebalance is scheduled this week'
                  : 'No rebalance is scheduled this week'}
              </p>
              <p className="mt-1 text-sm text-muted">
                {cadenceLabel(plan.rebalance_schedule)} from the live start date{' '}
                {displayDate(plan.rebalance_schedule.strategy_start_date)}. Previous rebalance:{' '}
                {displayDate(plan.rebalance_schedule.previous_rebalance_date)} · Next rebalance:{' '}
                {displayDate(plan.rebalance_schedule.next_rebalance_date)}.
              </p>
              {!plan.rebalance_schedule.is_rebalance_week ? (
                <p className="mt-1 text-sm text-muted">
                  The table below shows the changes needed to match the current model target; it is
                  not a scheduled rebalance for this signal week.
                </p>
              ) : null}
            </div>
          ) : null}
          {table.totals.buys + table.totals.sells === 0 ? (
            <p className="mb-3 text-sm text-muted">
              No weight changes are indicated: your holdings already match the model target.
            </p>
          ) : null}
          <Table stickyFirstCol>
            <THead>
              <Th>Asset</Th>
              <Th align="right">Current %</Th>
              <Th align="right">Target %</Th>
              <Th align="right">Change (pp)</Th>
              <Th>Action</Th>
              <Th align="right" className="hidden sm:table-cell">
                Price
              </Th>
              <Th align="right" className="hidden sm:table-cell">
                Indicative value
              </Th>
              <Th align="right" className="hidden sm:table-cell">
                Shares
              </Th>
            </THead>
            <tbody>
              {table.rows.map((row) => (
                <PlanRow key={row.asset} row={row} />
              ))}
              {table.cash ? <PlanRow row={table.cash} cash /> : null}
              <TRow className="border-b-0 border-t border-border font-medium hover:bg-transparent">
                <Td>
                  Total
                  <span className="block text-xs font-normal text-muted">
                    {formatInt(table.totals.buys)} buy · {formatInt(table.totals.sells)} sell ·{' '}
                    {formatInt(table.totals.holds)} hold
                  </span>
                  <span className="block text-xs font-normal text-muted sm:hidden">
                    Buys {formatInr(table.totals.buyValue, { dp: 2, trim: true })} · Sells{' '}
                    {formatInr(table.totals.sellValue, { dp: 2, trim: true })}
                  </span>
                </Td>
                <Td align="right" numeric>
                  {pct(table.totals.currentPct)}
                </Td>
                <Td align="right" numeric>
                  {pct(table.totals.targetPct)}
                </Td>
                <Td align="right" numeric>
                  {EMPTY}
                </Td>
                <Td>{EMPTY}</Td>
                <Td align="right" className="hidden sm:table-cell">
                  {EMPTY}
                </Td>
                <Td align="right" numeric className="hidden whitespace-nowrap sm:table-cell">
                  <span className="block">
                    Buys {formatInr(table.totals.buyValue, { dp: 2, trim: true })}
                  </span>
                  <span className="block">
                    Sells {formatInr(table.totals.sellValue, { dp: 2, trim: true })}
                  </span>
                </Td>
                <Td align="right" className="hidden sm:table-cell">
                  {EMPTY}
                </Td>
              </TRow>
            </tbody>
          </Table>
          <p className="mt-3 text-xs text-muted">
            HOLD rows are within 0.01 pp of the target; the preview prices only the assets it
            trades, so they show no price.
          </p>
          <p className="mt-2 text-xs text-muted">{plan.note}</p>
        </Card>
      ) : null}
    </div>
  );
}

function PlanRow({ row, cash = false }: { row: RebalanceTableRow; cash?: boolean }) {
  const traded = row.action !== 'HOLD' && !cash;
  return (
    <TRow className={cash ? 'bg-surface-2/30' : ''}>
      <Td>
        <span className="font-medium">{cash ? 'Cash' : row.asset}</span>
        <span className="block text-xs text-muted">
          {cash ? 'Unallocated remainder' : (row.symbol ?? EMPTY)}
        </span>
        {traded ? (
          <span className="block whitespace-nowrap text-xs text-muted sm:hidden">
            {formatInr(row.value, { dp: 2, trim: true })}
            {row.quantity != null ? ` · ${formatInt(row.quantity)} sh` : ''}
            {row.price != null ? ` @ ${formatInr(row.price, { dp: 2, trim: true })}` : ''}
          </span>
        ) : null}
      </Td>
      <Td align="right" numeric>
        {pct(row.currentPct)}
      </Td>
      <Td align="right" numeric>
        {pct(row.targetPct)}
      </Td>
      <Td
        align="right"
        numeric
        className={cn(
          'whitespace-nowrap',
          row.action === 'BUY' && 'text-positive',
          row.action === 'SELL' && 'text-negative',
          row.action === 'HOLD' && 'text-muted',
        )}
      >
        {formatPp(row.deltaPct, 2, { unit: 'percent' })}
      </Td>
      <Td>{cash ? EMPTY : <Badge tone={ACTION_TONE[row.action]}>{row.action}</Badge>}</Td>
      <Td align="right" numeric className="hidden whitespace-nowrap sm:table-cell">
        {formatInr(row.price, { dp: 2, trim: true })}
      </Td>
      <Td align="right" numeric className="hidden whitespace-nowrap sm:table-cell">
        {traded ? formatInr(row.value, { dp: 2, trim: true }) : EMPTY}
      </Td>
      <Td align="right" numeric className="hidden sm:table-cell">
        {row.quantity != null ? formatInt(row.quantity) : EMPTY}
      </Td>
    </TRow>
  );
}

/** `totals` is off for the report kept after loading: the rows can be edited, so a total would go stale. */
function PasteSummary({ result, totals = true }: { result: PasteResult; totals?: boolean }) {
  return (
    <div className="mt-2 space-y-1 text-xs" aria-live="polite">
      {totals ? (
        <p className={result.overAllocated ? 'text-negative' : 'text-muted'}>
          {formatInt(result.holdings.length)} holding{result.holdings.length === 1 ? '' : 's'}{' '}
          recognised, totalling {pct(result.total)}
          {result.overAllocated ? ' — more than 100%, so reduce a weight before previewing.' : '.'}
        </p>
      ) : null}
      {result.merged.length ? (
        <p className="text-muted">
          Listed more than once and added together: {result.merged.join(', ')}.
        </p>
      ) : null}
      {result.errors.length ? (
        <div className="text-warning">
          <p>
            Could not read {formatInt(result.errors.length)} line
            {result.errors.length === 1 ? '' : 's'}:
          </p>
          <ul className="list-disc pl-5">
            {result.errors.slice(0, 8).map((item) => (
              <li key={item.line}>
                Line {formatInt(item.line)} “{item.text}”: {item.reason}
              </li>
            ))}
            {result.errors.length > 8 ? (
              <li>and {formatInt(result.errors.length - 8)} more</li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
