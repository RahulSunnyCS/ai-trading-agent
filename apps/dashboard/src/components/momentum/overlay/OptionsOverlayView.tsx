'use client';

/**
 * Momentum › Options overlay (BL-227): a Momentum strategy's picks held as bought stock options
 * instead of shares, on NSE's daily F&O files. Calls on the picks, puts on falling F&O stocks,
 * the mirror pool, a market switch or both sides; one lot, premium per stock or a share of capital.
 * Descriptive only: BL-226 and BL-228 tested the registered forms and killed them.
 */

import { AlertTriangle, Loader2, Play, SlidersHorizontal } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import { useOptionsOverlayJob } from '../../../hooks/useOptionsOverlayJob';
import { usePolledResource } from '../../../hooks/usePolledResource';
import { cn } from '../../../lib/cn';
import {
  EMPTY,
  formatDay,
  formatInr,
  formatInt,
  formatNumber,
  formatPct,
  formatPp,
} from '../../../lib/format';
import {
  CALL_FILTER_LABEL,
  CUSTOM_LOOKBACKS,
  DEFAULT_CUSTOM,
  DEFAULT_REQUEST,
  DEFAULT_SLIPPAGE,
  DIRECTION_HELP,
  DIRECTION_LABEL,
  MARKET_FILTER_LABEL,
  MONEYNESS,
  SIZING_LABEL,
  buyText,
  countRows,
  customName,
  growthLines,
  needsStrategy,
  requestChips,
  requestProblem,
  sellText,
  tradesByDay,
  usesPutList,
} from '../../../lib/optionsOverlay';
import type {
  OverlayCallFilter,
  OverlayCustom,
  OverlayDirection,
  OverlayMarketFilter,
  OverlayMoneyness,
  OverlayRequest,
  OverlayResult,
  OverlaySizing,
  OverlayStrategies,
  OverlayTrade,
  OverlayWindow,
} from '../../../types/optionsOverlay';
import { Button } from '../../ui/Button';
import { Drawer } from '../../ui/Drawer';
import { Input, NumberField, Select } from '../../ui/Input';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { StatCard } from '../../ui/StatCard';
import { StateMessage } from '../../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../../ui/Table';
import { type ChartLine, MomentumLineChart } from '../MomentumLineChart';
import { OverlaySweeps } from './OverlaySweeps';

const STORAGE_KEY = 'ata.optionsOverlay.request';
const CUSTOM_VALUE = '__custom__';
const STRATEGIES_URL = '/api/momentum/options-overlay/strategies';

function loadStored(): OverlayRequest {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_REQUEST, ...(JSON.parse(raw) as Partial<OverlayRequest>) };
  } catch {
    // private window or blocked storage: the defaults
  }
  return DEFAULT_REQUEST;
}

function store(request: OverlayRequest): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(request));
  } catch {
    // not kept; the page works without it
  }
}

const signTone = (value: number | null | undefined) =>
  value === null || value === undefined ? 'default' : value >= 0 ? 'positive' : 'negative';

export function OptionsOverlayView() {
  const [request, setRequest] = useState<OverlayRequest>(DEFAULT_REQUEST);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showDrawdown, setShowDrawdown] = useState(false);
  useEffect(() => setRequest(loadStored()), []);
  const strategies = usePolledResource<OverlayStrategies>(STRATEGIES_URL, { cache: true });
  const job = useOptionsOverlayJob();
  const result = job.job?.status === 'done' ? job.job.result : null;
  const [shown, setShown] = useState<OverlayResult | null>(null);
  useEffect(() => {
    if (result) setShown(result);
  }, [result]);

  const list = strategies.data?.strategies ?? [];
  const strategyName = request.custom
    ? customName(request.custom)
    : (list.find((s) => s.id === request.favourite_id)?.name ?? null);
  const problem = requestProblem(request);
  const update = useCallback(
    (patch: Partial<OverlayRequest>) =>
      setRequest((current) => {
        const next = { ...current, ...patch };
        store(next);
        return next;
      }),
    [],
  );

  // a first visit with no strategy chosen: the headline favourite
  const firstChoice = (list.find((s) => s.active) ?? list[0])?.id ?? null;
  useEffect(() => {
    if (request.favourite_id === null && request.custom === null && firstChoice)
      update({ favourite_id: firstChoice });
  }, [firstChoice, request.favourite_id, request.custom, update]);

  const run = () => {
    if (problem) {
      setDrawerOpen(true);
      return;
    }
    setDrawerOpen(false);
    void job.start(request);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 shadow-card">
        <div className="flex min-w-0 flex-1 gap-1.5 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,black_92%,transparent)]">
          {requestChips(request, strategyName).map((chip) => (
            <button
              key={chip}
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="rounded-full border border-border bg-surface-2 px-2.5 py-0.5 text-xs text-muted hover:text-foreground"
            >
              {chip}
            </button>
          ))}
        </div>
        <span className="text-xs text-faint">
          F&amp;O data to{' '}
          {strategies.data?.data_through ? formatDay(strategies.data.data_through) : EMPTY}
        </span>
        <Button variant="secondary" size="sm" onClick={() => setDrawerOpen(true)}>
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden /> Settings
        </Button>
        <Button variant="primary" size="sm" onClick={run} loading={job.running}>
          <Play className="h-3.5 w-3.5" aria-hidden /> Run
        </Button>
      </div>

      <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-muted">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
        <span>
          Descriptive, not a finding. The registered tests of this idea were killed: calls on the
          picks failed on 2024-07 onward (BL-226), puts on falling stocks lost in every form and the
          mirror pool failed on drawdown (BL-228). Daily closes, not quotes; read the minimum
          capital and the top-5 % share beside every total.
        </span>
      </p>

      {job.error ? (
        <StateMessage variant="error" title="The run failed" description={job.error} />
      ) : null}
      {job.running ? (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Running
          {needsStrategy(request.direction)
            ? ': re-running the strategy on F&O stocks first (a minute or two the first time)'
            : ''}
          …
        </div>
      ) : null}

      {shown ? (
        <OverlayResultView
          result={shown}
          showDrawdown={showDrawdown}
          onToggleDrawdown={() => setShowDrawdown((v) => !v)}
        />
      ) : job.running ? null : (
        <StateMessage
          variant="empty"
          title="No run yet"
          description="Pick a strategy and the option settings, then Run."
        />
      )}

      <OverlaySweeps
        onOpen={(settings) => {
          const next = { ...DEFAULT_REQUEST, ...settings } as OverlayRequest;
          setRequest(next);
          store(next);
          setDrawerOpen(false);
          void job.start(next);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
      />

      <Drawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        title="Options overlay settings"
        subtitle="What the next run tests"
        footer={
          <div className="flex items-center justify-end gap-2">
            {problem ? <span className="mr-auto text-xs text-negative">{problem}</span> : null}
            <Button variant="secondary" size="sm" onClick={() => update(DEFAULT_REQUEST)}>
              Reset
            </Button>
            <Button variant="primary" size="sm" onClick={run} disabled={problem !== null}>
              <Play className="h-3.5 w-3.5" aria-hidden /> Run
            </Button>
          </div>
        }
      >
        <OverlaySettings
          request={request}
          update={update}
          strategies={strategies.data}
          loadingStrategies={strategies.loading}
        />
      </Drawer>
    </div>
  );
}

function Field({
  label,
  help,
  children,
}: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-foreground">{label}</div>
      {children}
      {help ? <p className="text-xs text-faint">{help}</p> : null}
    </div>
  );
}

function OverlaySettings({
  request,
  update,
  strategies,
  loadingStrategies,
}: {
  request: OverlayRequest;
  update: (patch: Partial<OverlayRequest>) => void;
  strategies: OverlayStrategies | null;
  loadingStrategies: boolean;
}) {
  const list = strategies?.strategies ?? [];
  return (
    <div className="space-y-5">
      <Field label="Direction" help={DIRECTION_HELP[request.direction]}>
        <Select
          aria-label="Direction"
          value={request.direction}
          onChange={(e) => update({ direction: e.target.value as OverlayDirection })}
        >
          {(Object.keys(DIRECTION_LABEL) as OverlayDirection[]).map((d) => (
            <option key={d} value={d}>
              {DIRECTION_LABEL[d]}
            </option>
          ))}
        </Select>
      </Field>

      {needsStrategy(request.direction) ? (
        <Field
          label="Strategy"
          help="A saved Broad favourite or group, or a custom strategy, run on the F&O stocks of each year so every pick has options. Its result there is the shares book."
        >
          <Select
            aria-label="Strategy"
            value={request.custom ? CUSTOM_VALUE : (request.favourite_id ?? '')}
            onChange={(e) =>
              e.target.value === CUSTOM_VALUE
                ? update({ custom: request.custom ?? DEFAULT_CUSTOM, favourite_id: null })
                : update({ favourite_id: e.target.value || null, custom: null })
            }
          >
            <option value="">{loadingStrategies ? 'Loading…' : 'Pick a strategy'}</option>
            <option value={CUSTOM_VALUE}>Custom strategy…</option>
            {list.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.sleeves > 1 ? ` · ${s.sleeves} sleeves` : ''}
                {s.active ? ' · headline' : ''}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      {needsStrategy(request.direction) && request.custom ? (
        <CustomStrategyFields custom={request.custom} onChange={(custom) => update({ custom })} />
      ) : null}

      {usesPutList(request.direction) ? (
        <Field
          label={
            request.direction === 'mirror' ? 'Charts a week (top N)' : 'Falling stocks a week (N)'
          }
        >
          <NumberField
            aria-label="N"
            className="w-24"
            min={1}
            max={30}
            value={request.n}
            onChange={(n) => update({ n })}
          />
        </Field>
      ) : null}

      {request.direction === 'switch' ? (
        <Field label="The market is falling when">
          <Select
            aria-label="Market filter"
            value={request.market_filter}
            onChange={(e) => update({ market_filter: e.target.value as OverlayMarketFilter })}
          >
            {(Object.keys(MARKET_FILTER_LABEL) as OverlayMarketFilter[]).map((f) => (
              <option key={f} value={f}>
                {MARKET_FILTER_LABEL[f]}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      {request.direction === 'both' ? (
        <Field label="Puts' share of the budget (%)">
          <NumberField
            aria-label="Puts' share"
            className="w-24"
            min={0}
            max={100}
            value={Math.round(request.put_share * 100)}
            onChange={(v) => update({ put_share: v / 100 })}
          />
        </Field>
      ) : null}

      <Field
        label="Moneyness"
        help="ATM is the listed strike nearest the stock's close; ITM1-2 are one or two strikes in the money, OTM1-3 out of it (for a call, below / above the price; the other way for a put). Delta picks the strike whose delta, read from its own price, is nearest the target."
      >
        <SegmentedControl
          ariaLabel="Moneyness"
          size="sm"
          value={request.moneyness}
          options={MONEYNESS.map((m) => ({ value: m, label: m === 'DELTA' ? 'Delta' : m }))}
          onChange={(m: OverlayMoneyness) => update({ moneyness: m })}
        />
        {request.moneyness === 'DELTA' ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted">
            <span>Target delta (%)</span>
            <NumberField
              aria-label="Target delta"
              className="w-24"
              min={5}
              max={95}
              value={Math.round(request.delta_target * 100)}
              onChange={(v) => update({ delta_target: v / 100 })}
            />
          </div>
        ) : null}
      </Field>

      <Field
        label="Expiry"
        help="The nearest expiry with enough sessions left, or one or two after it."
      >
        <SegmentedControl
          ariaLabel="Expiry"
          size="sm"
          value={String(request.expiry_skip)}
          options={[
            { value: '0', label: 'Nearest' },
            { value: '1', label: 'Next one' },
            { value: '2', label: 'Two out' },
          ]}
          onChange={(v) => update({ expiry_skip: Number(v) })}
        />
      </Field>

      <Field
        label="Hold while picked"
        help="Keep a contract while its stock is still picked, instead of selling and buying it again every week (no costs or slippage on the weeks it is kept). It is rolled once it has fewer sessions left than the minimum."
      >
        <SegmentedControl
          ariaLabel="Hold while picked"
          size="sm"
          value={request.hold ? 'on' : 'off'}
          options={[
            { value: 'off', label: 'Sell weekly' },
            { value: 'on', label: 'Hold' },
          ]}
          onChange={(v) => update({ hold: v === 'on' })}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Stop (% of premium)"
          help="Sell on the first daily close this far below the buy price. Empty = off."
        >
          <Input
            aria-label="Stop"
            inputMode="decimal"
            placeholder="off"
            value={request.stop === null ? '' : String(Math.round(request.stop * 100))}
            onChange={(e) => {
              const v = Number(e.target.value);
              update({ stop: e.target.value === '' || !(v > 0) ? null : v / 100 });
            }}
          />
        </Field>
        <Field
          label="Target (% of premium)"
          help="Sell on the first daily close this far above it. Empty = off."
        >
          <Input
            aria-label="Target"
            inputMode="decimal"
            placeholder="off"
            value={request.target === null ? '' : String(Math.round(request.target * 100))}
            onChange={(e) => {
              const v = Number(e.target.value);
              update({ target: e.target.value === '' || !(v > 0) ? null : v / 100 });
            }}
          />
        </Field>
      </div>

      {request.direction === 'calls' || request.direction === 'both' ? (
        <Field label="Buy calls only when">
          <Select
            aria-label="Calls filter"
            value={request.call_filter}
            onChange={(e) => update({ call_filter: e.target.value as OverlayCallFilter })}
          >
            <option value="none">Always</option>
            {(Object.keys(CALL_FILTER_LABEL) as Array<keyof typeof CALL_FILTER_LABEL>).map((f) => (
              <option key={f} value={f}>
                {CALL_FILTER_LABEL[f]}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Positions a week (max)">
          <Input
            aria-label="Max positions"
            inputMode="numeric"
            placeholder="no cap"
            value={request.max_positions === null ? '' : String(request.max_positions)}
            onChange={(e) => {
              const v = Math.round(Number(e.target.value));
              update({ max_positions: e.target.value === '' || !(v >= 1) ? null : v });
            }}
          />
        </Field>
        <Field label="Premium a week (max % of capital)">
          <Input
            aria-label="Max weekly premium"
            inputMode="decimal"
            placeholder="no cap"
            value={
              request.max_weekly_premium === null
                ? ''
                : String(Math.round(request.max_weekly_premium * 100))
            }
            onChange={(e) => {
              const v = Number(e.target.value);
              update({ max_weekly_premium: e.target.value === '' || !(v > 0) ? null : v / 100 });
            }}
          />
        </Field>
      </div>

      <Field label="Sizing">
        <SegmentedControl
          ariaLabel="Sizing"
          size="sm"
          value={request.sizing}
          options={(Object.keys(SIZING_LABEL) as OverlaySizing[]).map((s) => ({
            value: s,
            label: SIZING_LABEL[s],
          }))}
          onChange={(sizing: OverlaySizing) =>
            update({
              sizing,
              sizing_value: sizing === 'capital_share' ? 0.2 : sizing === 'exposure' ? 1 : null,
            })
          }
        />
        {request.sizing === 'exposure' ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted">
            <span>Exposure a week, % of capital (delta × stock value, split over the picks)</span>
            <NumberField
              aria-label="Exposure"
              className="w-24"
              min={5}
              max={500}
              value={Math.round((request.sizing_value ?? 1) * 100)}
              onChange={(v) => update({ sizing_value: v / 100 })}
            />
          </div>
        ) : null}
        {request.sizing === 'premium' ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted">
            <span>Premium a stock (₹, empty = capital ÷ sleeves ÷ N)</span>
            <Input
              aria-label="Premium per stock"
              className="w-32"
              inputMode="numeric"
              value={request.sizing_value ?? ''}
              onChange={(e) => {
                const v = Number(e.target.value);
                update({ sizing_value: e.target.value === '' || !(v > 0) ? null : v });
              }}
            />
          </div>
        ) : null}
        {request.sizing === 'capital_share' ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted">
            <span>Premium a week, % of capital</span>
            <NumberField
              aria-label="Share of capital"
              className="w-24"
              min={1}
              max={100}
              value={Math.round((request.sizing_value ?? 0.2) * 100)}
              onChange={(v) => update({ sizing_value: v / 100 })}
            />
          </div>
        ) : null}
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Capital (₹)">
          <NumberField
            aria-label="Capital"
            min={10_000}
            max={1_000_000_000}
            value={request.capital}
            onChange={(capital) => update({ capital })}
          />
        </Field>
        <Field label="From">
          <Input
            aria-label="Start"
            type="date"
            min="2020-01-01"
            value={request.start}
            onChange={(e) => update({ start: e.target.value || '2020-01-01' })}
          />
        </Field>
        <Field label="Until (empty = the newest data)">
          <Input
            aria-label="End"
            type="date"
            min="2020-01-01"
            value={request.end ?? ''}
            onChange={(e) => update({ end: e.target.value || null })}
          />
        </Field>
        <Field label="Train / test split (optional)">
          <Input
            aria-label="Split"
            type="date"
            min="2020-01-01"
            value={request.split ?? ''}
            onChange={(e) => update({ split: e.target.value || null })}
          />
        </Field>
        <Field label="Sessions left at entry (min)">
          <NumberField
            aria-label="Minimum sessions left"
            min={1}
            max={60}
            value={request.min_sessions_left}
            onChange={(v) => update({ min_sessions_left: v })}
          />
        </Field>
        <Field label="Open interest (min lots)">
          <NumberField
            aria-label="Minimum open interest"
            min={0}
            max={1000}
            value={request.min_oi_lots}
            onChange={(v) => update({ min_oi_lots: v })}
          />
        </Field>
        <Field
          label="Slippage (% of premium each way)"
          help={`Default for ${request.moneyness}: ${formatPct(DEFAULT_SLIPPAGE[request.moneyness], 0)}`}
        >
          <Input
            aria-label="Slippage"
            inputMode="decimal"
            placeholder={String(DEFAULT_SLIPPAGE[request.moneyness] * 100)}
            value={request.slippage === null ? '' : String(request.slippage * 100)}
            onChange={(e) => {
              const v = Number(e.target.value);
              update({
                slippage: e.target.value === '' || !(v >= 0 && v < 50) ? null : v / 100,
              });
            }}
          />
        </Field>
        <Field
          label="Profit booking"
          help="Each time the trading account is a whole step above where it last booked, that share of the step is taken out; the rest stays and the next weeks are sized on the account."
        >
          <SegmentedControl
            ariaLabel="Profit booking"
            size="sm"
            value={request.profit_step ? 'on' : 'off'}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'on', label: 'On' },
            ]}
            onChange={(v) => update({ profit_step: v === 'on' ? 50_000 : null })}
          />
        </Field>
        {request.profit_step ? (
          <>
            <Field label="Every ₹ of profit">
              <NumberField
                aria-label="Profit step"
                min={1000}
                max={100_000_000}
                value={request.profit_step}
                onChange={(v) => update({ profit_step: v })}
              />
            </Field>
            <Field label="Take out (%)">
              <NumberField
                aria-label="Share taken out"
                min={0}
                max={100}
                value={Math.round(request.withdraw_share * 100)}
                onChange={(v) => update({ withdraw_share: v / 100 })}
              />
            </Field>
            <Field
              label="Refill from money taken out"
              help="A week the account cannot pay for a pick, money taken out earlier goes back in, up to the starting capital, so the book keeps trading."
            >
              <SegmentedControl
                ariaLabel="Refill from money taken out"
                size="sm"
                value={request.refill ? 'on' : 'off'}
                options={[
                  { value: 'on', label: 'On' },
                  { value: 'off', label: 'Off' },
                ]}
                onChange={(v) => update({ refill: v === 'on' })}
              />
            </Field>
          </>
        ) : null}
        <Field label="Tax">
          <SegmentedControl
            ariaLabel="Tax"
            size="sm"
            value={request.tax ? 'on' : 'off'}
            options={[
              { value: 'on', label: 'After tax' },
              { value: 'off', label: 'Before tax' },
            ]}
            onChange={(v) => update({ tax: v === 'on' })}
          />
        </Field>
      </div>
      <p className="text-xs text-faint">
        Bought at each week&apos;s last F&amp;O session close, sold at the next; the expiry is the
        nearest with enough sessions left. Costs: ₹20 an order, STT, exchange and SEBI charges,
        stamp duty and GST. Tax: each financial year&apos;s net at 31.2 %, losses carried forward.
      </p>
    </div>
  );
}

function Widget({
  title,
  meta,
  wide = false,
  children,
}: {
  title: string;
  meta?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className={cn(
        'min-w-0 rounded-xl border border-border bg-surface shadow-card',
        wide && 'lg:col-span-2',
      )}
    >
      <header className="flex items-center gap-3 whitespace-nowrap px-4 pb-2 pt-3">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {meta ? <p className="min-w-0 flex-1 truncate text-xs text-faint">{meta}</p> : null}
      </header>
      <div className="px-4 pb-4">{children}</div>
    </section>
  );
}

function OverlayResultView({
  result,
  showDrawdown,
  onToggleDrawdown,
}: {
  result: OverlayResult;
  showDrawdown: boolean;
  onToggleDrawdown: () => void;
}) {
  const { book, shares, nifty, min_capital: mc, stats } = result;
  const compare = shares ?? nifty;
  const compareName = shares ? 'shares' : 'NIFTY';
  const lines = useMemo<ChartLine[]>(() => {
    const g = growthLines(result);
    const out: ChartLine[] = [
      { name: 'Options book', values: g.options, role: 'strategy', hover: tradesByDay(result) },
    ];
    if (g.shares) out.push({ name: 'Same picks as shares', values: g.shares, role: 'benchmark' });
    if (g.nifty) out.push({ name: 'NIFTY', values: g.nifty, role: 'benchmark', dash: 'dot' });
    if (result.booking) {
      const capital = result.settings.capital;
      out.push({
        name: 'Trading account',
        values: result.booking.account.map((v) => v / capital - 1),
        role: 'strategy',
        dash: 'dot',
      });
      out.push({
        name: 'Taken out',
        values: result.booking.taken.map((v) => v / capital),
        role: 'negative',
        dash: 'dot',
      });
    }
    return out;
  }, [result]);
  const ddLines = useMemo<ChartLine[]>(
    () => [{ name: 'Drawdown', values: result.series.drawdown, role: 'negative', fill: true }],
    [result],
  );

  const short =
    mc.suggested_rs !== null && result.settings.capital < mc.suggested_rs ? mc.suggested_rs : null;

  return (
    <>
      {short !== null ? (
        <p className="flex items-start gap-2 rounded-lg border border-negative/30 bg-negative/10 px-3 py-2 text-xs text-muted">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-negative" aria-hidden />
          <span>
            Capital {formatInr(result.settings.capital, { compact: true })} is below the{' '}
            {formatInr(short, { compact: true })} this book needed at one lot of each pick, so its
            percentages and drawdown are not meaningful. Raise the capital, or read the rupee
            figures.
          </span>
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard
          label={result.settings.tax ? 'Total, after tax' : 'Total, before tax'}
          value={formatInr(book.total_rs, { sign: true, compact: true })}
          tone={signTone(book.total_rs)}
          note={`${formatPct(book.total, 0, { sign: true })} on ${formatInr(result.settings.capital, { compact: true })}`}
          {...(compare
            ? {
                delta: `${compareName} ${formatPct(compare.total, 0, { sign: true })}`,
                deltaTone: signTone(book.total - compare.total),
              }
            : {})}
        />
        <StatCard
          label="CAGR"
          value={book.cagr === null ? 'Lost it all' : formatPct(book.cagr, 1)}
          tone={signTone(book.cagr)}
          {...(compare && compare.cagr !== null && book.cagr !== null
            ? {
                delta: formatPp(book.cagr - compare.cagr),
                deltaTone: signTone(book.cagr - compare.cagr),
              }
            : {})}
          note={compare ? `${compareName} ${formatPct(compare.cagr, 1)}` : undefined}
        />
        <StatCard
          label="Max drawdown"
          value={formatPct(book.max_dd, 0)}
          tone="negative"
          note={
            book.dd_peak && book.dd_trough
              ? `${formatDay(book.dd_peak)} → ${formatDay(book.dd_trough)}`
              : undefined
          }
          {...(compare
            ? {
                delta: `${compareName} ${formatPct(compare.max_dd, 0)}`,
                deltaTone: 'muted' as const,
              }
            : {})}
        />
        <StatCard
          label="Capital it needed"
          value={formatInr(mc.suggested_rs, { compact: true })}
          hint="One lot of every pick: the 90th-percentile week's premium plus the worst fall of that one-lot book."
          note={
            mc.weekly_premium
              ? `premium ${formatInr(mc.weekly_premium.median, { compact: true })} a week (median)`
              : undefined
          }
        />
        <StatCard
          label="Win rate"
          value={formatPct(stats.win_rate, 0)}
          note={`${formatInt(stats.trades)} trades · payoff ${formatNumber(stats.payoff, 2)}`}
          {...(stats.top5pct_share !== null && stats.top5pct_share !== undefined
            ? {
                delta: `top 5 % = ${formatPct(stats.top5pct_share, 0)} of net`,
                deltaTone: stats.top5pct_share > 1 ? ('negative' as const) : ('muted' as const),
              }
            : {})}
        />
      </div>

      <section className="rounded-xl border border-border bg-surface px-3 pb-2 pt-3 shadow-card">
        <header className="flex items-center gap-3 px-1 pb-1">
          <h3 className="text-sm font-semibold">
            {result.strategy ? `${result.strategy} · ` : ''}
            {DIRECTION_LABEL[result.settings.direction]} · {result.settings.moneyness}
          </h3>
          <p className="min-w-0 flex-1 truncate text-xs text-faint">
            {formatDay(result.first_day)} → {formatDay(result.last_day)} · {result.weeks} weeks ·
            growth of {formatInr(result.settings.capital, { compact: true })}
            {book.went_below_zero ? ' · the book lost more than its capital' : ''}
          </p>
          <Button variant="ghost" size="sm" onClick={onToggleDrawdown} aria-pressed={showDrawdown}>
            Drawdown
          </Button>
        </header>
        <MomentumLineChart
          dates={result.series.days}
          lines={lines}
          height={420}
          label="Growth of the options book, the same picks as shares and NIFTY"
        />
        {showDrawdown ? (
          <MomentumLineChart
            dates={result.series.days}
            lines={ddLines}
            height={160}
            label="Options book drawdown"
          />
        ) : null}
      </section>

      <div className="grid gap-3 lg:grid-cols-2">
        <Widget title="Capital it needed" meta="One lot of every pick each week">
          <Table>
            <THead>
              <Th dense>Measure</Th>
              <Th align="right" dense>
                Median
              </Th>
              <Th align="right" dense>
                90th pct
              </Th>
              <Th align="right" dense>
                Largest
              </Th>
            </THead>
            <tbody>
              {mc.weekly_premium ? (
                <TRow>
                  <Td dense>Premium a week</Td>
                  <Td numeric align="right" dense>
                    {formatInr(mc.weekly_premium.median)}
                  </Td>
                  <Td numeric align="right" dense>
                    {formatInr(mc.weekly_premium.p90)}
                  </Td>
                  <Td numeric align="right" dense>
                    {formatInr(mc.weekly_premium.max)}
                  </Td>
                </TRow>
              ) : null}
              {mc.one_lot ? (
                <TRow>
                  <Td dense>One lot of one stock</Td>
                  <Td numeric align="right" dense>
                    {formatInr(mc.one_lot.median)}
                  </Td>
                  <Td numeric align="right" dense>
                    {formatInr(mc.one_lot.p90)}
                  </Td>
                  <Td numeric align="right" dense>
                    {formatInr(mc.one_lot.max)}
                  </Td>
                </TRow>
              ) : null}
              {mc.positions_per_week ? (
                <TRow>
                  <Td dense>Positions a week</Td>
                  <Td numeric align="right" dense>
                    {formatInt(mc.positions_per_week.median)}
                  </Td>
                  <Td numeric align="right" dense>
                    {EMPTY}
                  </Td>
                  <Td numeric align="right" dense>
                    {formatInt(mc.positions_per_week.max)}
                  </Td>
                </TRow>
              ) : null}
            </tbody>
          </Table>
          <p className="mt-2 text-xs text-muted">
            Worst fall at one lot each, before tax: {formatInr(mc.worst_fall_rs)}. Suggested capital
            = 90th-percentile premium + that fall = {formatInr(mc.suggested_rs)}.
          </p>
        </Widget>

        <Widget title="Trades" meta="Before tax, after costs and slippage">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
            <Stat label="Trades" value={formatInt(stats.trades)} />
            <Stat label="Won" value={formatPct(stats.win_rate, 0)} />
            <Stat label="Weeks won" value={formatPct(stats.weeks_won, 0)} />
            <Stat label="Payoff (avg win ÷ avg loss)" value={formatNumber(stats.payoff, 2)} />
            <Stat label="Average win" value={formatInr(stats.avg_win_rs)} />
            <Stat label="Average loss" value={formatInr(stats.avg_loss_rs)} />
            <Stat
              label="Net before tax"
              value={formatInr(stats.net_before_tax_rs, { sign: true })}
            />
            <Stat
              label="Without the top 5 %"
              value={formatInr(stats.net_without_top5pct_rs, { sign: true })}
            />
            <Stat label="Costs" value={formatInr(book.costs_rs)} />
            <Stat label="Tax" value={formatInr(book.tax_rs)} />
            <Stat
              label="Weekly return, 90 % range"
              value={
                book.weekly_90
                  ? `${formatPct(book.weekly_90[0], 2)} to ${formatPct(book.weekly_90[1], 2)}`
                  : EMPTY
              }
            />
          </dl>
        </Widget>

        {result.windows ? <WindowsWidget result={result} /> : null}
        {result.booking ? <BookingWidget result={result} /> : null}

        <Widget title="Calls and puts" meta="What each side earned, before tax">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
            <Stat label="Call trades" value={formatInt(result.sides.calls.trades)} />
            <Stat label="Calls net" value={formatInr(result.sides.calls.net_rs, { sign: true })} />
            <Stat label="Put trades" value={formatInt(result.sides.puts.trades)} />
            <Stat label="Puts net" value={formatInr(result.sides.puts.net_rs, { sign: true })} />
            {result.sides.weeks_down !== undefined ? (
              <>
                <Stat
                  label="Weeks the market was rising"
                  value={formatInt(result.sides.weeks_up)}
                />
                <Stat label="Weeks it was falling" value={formatInt(result.sides.weeks_down)} />
              </>
            ) : null}
          </dl>
        </Widget>

        <Widget title="Skips and fills" meta="How many picks each rule touched">
          <ul className="space-y-1 text-sm">
            <li className="flex justify-between">
              <span className="text-muted">Picks considered</span>
              <span className="font-mono">{formatInt(result.counts.entries)}</span>
            </li>
            {countRows(result.counts).map((row) => (
              <li key={row.label} className="flex justify-between gap-3">
                <span className="truncate text-muted" title={row.label}>
                  {row.label}
                </span>
                <span className="font-mono">{formatInt(row.value)}</span>
              </li>
            ))}
          </ul>
        </Widget>

        <Widget title="By year" meta="Options P&L by the year a trade closed" wide>
          <Table>
            <THead>
              <Th dense>Year</Th>
              <Th align="right" dense>
                Trades
              </Th>
              <Th align="right" dense>
                Won
              </Th>
              <Th align="right" dense>
                Calls
              </Th>
              <Th align="right" dense>
                Puts
              </Th>
              <Th align="right" dense>
                Before tax
              </Th>
              <Th align="right" dense>
                After tax
              </Th>
              {shares ? (
                <Th align="right" dense>
                  Shares
                </Th>
              ) : null}
            </THead>
            <tbody>
              {result.by_year.map((y) => (
                <TRow key={y.year}>
                  <Td dense>{y.year}</Td>
                  <Td numeric align="right" dense>
                    {formatInt(y.trades)}
                  </Td>
                  <Td numeric align="right" dense>
                    {formatPct(y.win_rate, 0)}
                  </Td>
                  <Td numeric align="right" dense>
                    <Money value={y.calls_rs} />
                  </Td>
                  <Td numeric align="right" dense>
                    <Money value={y.puts_rs} />
                  </Td>
                  <Td numeric align="right" dense>
                    <Money value={y.before_tax_rs} />
                  </Td>
                  <Td numeric align="right" dense>
                    <Money value={y.after_tax_rs} />
                  </Td>
                  {shares ? (
                    <Td numeric align="right" dense>
                      {formatPct(y.shares_return, 0, { sign: true })}
                    </Td>
                  ) : null}
                </TRow>
              ))}
            </tbody>
          </Table>
        </Widget>

        <ByStock rows={result.by_stock} />
        <TradeList title="Best trades" trades={stats.best ?? []} />
        <TradeList title="Worst trades" trades={stats.worst ?? []} />
        <AllTrades trades={result.trades} />
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt className="truncate text-muted">{label}</dt>
      <dd className="text-right font-mono">{value}</dd>
    </>
  );
}

function Money({ value }: { value: number | null | undefined }) {
  return (
    <span
      className={cn(
        value !== null && value !== undefined && value < 0
          ? 'text-negative'
          : value
            ? 'text-positive'
            : 'text-muted',
      )}
    >
      {formatInr(value, { sign: true, compact: true })}
    </span>
  );
}

function ByStock({ rows }: { rows: OverlayResult['by_stock'] }) {
  const [all, setAll] = useState(false);
  const shown = all
    ? rows
    : [...rows.slice(0, 10), ...rows.slice(-5).filter((r) => !rows.slice(0, 10).includes(r))];
  return (
    <Widget
      title="Winners and losers by stock"
      meta={`${rows.length} stocks · top 10 and bottom 5`}
      wide
    >
      <Table {...(all ? { maxHeight: 480 } : {})}>
        <THead>
          <Th dense>Stock</Th>
          <Th align="right" dense>
            Trades
          </Th>
          <Th align="right" dense>
            Won
          </Th>
          <Th align="right" dense>
            Net
          </Th>
          <Th align="right" dense>
            Best
          </Th>
          <Th align="right" dense>
            Worst
          </Th>
          <Th align="right" dense>
            Premium paid
          </Th>
        </THead>
        <tbody>
          {shown.map((r) => (
            <TRow key={r.symbol}>
              <Td dense>{r.symbol}</Td>
              <Td numeric align="right" dense>
                {formatInt(r.trades)}
              </Td>
              <Td numeric align="right" dense>
                {formatPct(r.win_rate, 0)}
              </Td>
              <Td numeric align="right" dense>
                <Money value={r.net_rs} />
              </Td>
              <Td numeric align="right" dense>
                {formatInr(r.best_rs, { compact: true })}
              </Td>
              <Td numeric align="right" dense>
                {formatInr(r.worst_rs, { compact: true })}
              </Td>
              <Td numeric align="right" dense>
                {formatInr(r.premium_rs, { compact: true })}
              </Td>
            </TRow>
          ))}
        </tbody>
      </Table>
      {rows.length > 15 ? (
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => setAll((v) => !v)}>
          {all ? 'Show top and bottom' : `Show all ${rows.length}`}
        </Button>
      ) : null}
    </Widget>
  );
}

function tradeRow(t: OverlayTrade, i: number) {
  return (
    <TRow key={`${t.entry}-${t.symbol}-${t.right}-${i}`} className="whitespace-nowrap">
      <Td dense>{formatDay(t.entry)}</Td>
      <Td dense title={`Expiry ${formatDay(t.expiry)}`}>
        <span className={t.right === 'PE' ? 'text-negative' : 'text-positive'}>Buy</span>{' '}
        {buyText(t).slice(4)} <span className="text-faint">→</span>{' '}
        <span className={t.exit_how === 'zero' ? 'text-negative' : 'text-muted'}>
          {sellText(t)}
        </span>
      </Td>
      <Td dense>{formatDay(t.exit)}</Td>
      <Td numeric align="right" dense>
        {formatInt(t.lots * t.lot)}
      </Td>
      <Td numeric align="right" dense>
        {formatInr(t.buy, { compact: true })}
      </Td>
      <Td numeric align="right" dense>
        <Money value={t.pnl} />
      </Td>
    </TRow>
  );
}

function TradeHead() {
  return (
    <THead>
      <Th dense>Bought</Th>
      <Th dense>Trade</Th>
      <Th dense>Sold</Th>
      <Th align="right" dense>
        Qty
      </Th>
      <Th align="right" dense>
        Paid
      </Th>
      <Th align="right" dense>
        P&amp;L
      </Th>
    </THead>
  );
}

function TradeList({ title, trades }: { title: string; trades: OverlayTrade[] }) {
  return (
    <Widget title={title} meta="After costs and slippage, before tax" wide>
      <Table>
        <TradeHead />
        <tbody>{trades.map(tradeRow)}</tbody>
      </Table>
    </Widget>
  );
}

function AllTrades({ trades }: { trades: OverlayTrade[] }) {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(50);
  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    const rows = q ? trades.filter((t) => t.symbol.includes(q)) : trades;
    return [...rows].sort((a, b) => (a.entry < b.entry ? 1 : a.entry > b.entry ? -1 : 0));
  }, [trades, query]);
  return (
    <Widget
      title="All trades"
      meta="Each row: what was bought, what it was sold at, quantity, premium paid and P&L"
      wide
    >
      <div className="mb-2 flex items-center gap-2">
        <Input
          aria-label="Filter trades by stock"
          placeholder="Stock"
          className="w-40"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="text-xs text-faint">{formatInt(filtered.length)} trades</span>
      </div>
      <Table maxHeight={520}>
        <TradeHead />
        <tbody>{filtered.slice(0, limit).map(tradeRow)}</tbody>
      </Table>
      {filtered.length > limit ? (
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => setLimit((n) => n + 200)}>
          Show more
        </Button>
      ) : null}
    </Widget>
  );
}

function BookingWidget({ result }: { result: OverlayResult }) {
  const b = result.booking;
  const [all, setAll] = useState(false);
  if (!b) return null;
  const rows = all ? b.bookings : b.bookings.slice(-8);
  const outs = b.bookings.filter((e) => e.kind === 'out').length;
  const ins = b.bookings.length - outs;
  return (
    <Widget
      title="Profit booking"
      meta={`Take out ${formatPct(b.withdraw_share, 0)} of each ${formatInr(b.profit_step, { compact: true })} made${b.refill ? ' · refilled from it when short' : ''} · before tax`}
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
        <Stat label="Started with" value={formatInr(result.settings.capital)} />
        <Stat label="Trading account at the end" value={formatInr(b.account_end_rs)} />
        <Stat label={`Taken out (${formatInt(outs)} times)`} value={formatInr(b.out_rs)} />
        <Stat label={`Moved back in (${formatInt(ins)} times)`} value={formatInr(b.in_rs)} />
        <Stat label="Kept out at the end" value={formatInr(b.taken_rs)} />
      </dl>
      {b.bookings.length ? (
        <Table>
          <THead>
            <Th dense>Day</Th>
            <Th dense>Move</Th>
            <Th align="right" dense>
              Amount
            </Th>
            <Th align="right" dense>
              Account after
            </Th>
          </THead>
          <tbody>
            {[...rows].reverse().map((e) => (
              <TRow key={`${e.day}-${e.kind}`}>
                <Td dense>{formatDay(e.day)}</Td>
                <Td dense>
                  <span className={e.kind === 'out' ? 'text-positive' : 'text-warning'}>
                    {e.kind === 'out' ? 'Taken out' : 'Moved back in'}
                  </span>
                </Td>
                <Td numeric align="right" dense>
                  {formatInr(e.amount_rs)}
                </Td>
                <Td numeric align="right" dense>
                  {formatInr(e.account_rs)}
                </Td>
              </TRow>
            ))}
          </tbody>
        </Table>
      ) : (
        <p className="mt-2 text-xs text-muted">
          The account never stood a whole step above its start.
        </p>
      )}
      {b.bookings.length > 8 ? (
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => setAll((v) => !v)}>
          {all ? 'Show the last 8' : `Show all ${b.bookings.length}`}
        </Button>
      ) : null}
    </Widget>
  );
}

function CustomStrategyFields({
  custom,
  onChange,
}: {
  custom: OverlayCustom;
  onChange: (custom: OverlayCustom) => void;
}) {
  const set = (patch: Partial<OverlayCustom>) => onChange({ ...custom, ...patch });
  const toggle = (weeks: number) =>
    set({
      lookbacks: custom.lookbacks.includes(weeks)
        ? custom.lookbacks.filter((w) => w !== weeks)
        : [...custom.lookbacks, weeks].sort((a, b) => a - b),
    });
  return (
    <div className="space-y-4 rounded-lg border border-border bg-surface-2 p-3">
      <Field
        label="Look-backs (weeks)"
        help="The score reads each stock's return over these windows, as Momentum's Broad engine does."
      >
        <div className="flex flex-wrap gap-1.5">
          {CUSTOM_LOOKBACKS.map((weeks) => {
            const on = custom.lookbacks.includes(weeks);
            return (
              <button
                key={weeks}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(weeks)}
                className={cn(
                  'rounded-full border px-2.5 py-0.5 text-xs',
                  on
                    ? 'border-primary bg-primary/15 text-foreground'
                    : 'border-border text-muted hover:text-foreground',
                )}
              >
                {weeks}w
              </button>
            );
          })}
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Stocks held (top N)">
          <NumberField
            aria-label="Top N"
            min={1}
            max={30}
            value={custom.top_n}
            onChange={(top_n) => set({ top_n, exit_rank: Math.max(custom.exit_rank, top_n) })}
          />
        </Field>
        <Field label="Sell when rank falls below">
          <NumberField
            aria-label="Exit rank"
            min={custom.top_n}
            max={100}
            value={custom.exit_rank}
            onChange={(exit_rank) => set({ exit_rank })}
          />
        </Field>
      </div>
      <Field label="Rebalance">
        <SegmentedControl
          ariaLabel="Rebalance"
          size="sm"
          value={custom.rebalance}
          options={[
            { value: 'weekly', label: 'Weekly' },
            { value: 'fortnightly', label: 'Every 2 weeks' },
            { value: 'monthly', label: 'Monthly' },
          ]}
          onChange={(rebalance: OverlayCustom['rebalance']) => set({ rebalance })}
        />
      </Field>
      <Field label="Score">
        <SegmentedControl
          ariaLabel="Score"
          size="sm"
          value={custom.score}
          options={[
            { value: 'ranksum', label: 'Rank-sum' },
            { value: 'voladj', label: 'Volatility-adjusted' },
          ]}
          onChange={(score: OverlayCustom['score']) => set({ score })}
        />
      </Field>
      <p className="text-xs text-faint">
        Fixed: F&amp;O stocks of each year that pass the liquidity filter (₹2 crore turnover, ₹30
        price), at most 25 % in one stock, bought at Friday&apos;s close a week after the signal,
        itemised costs and 0.15 % slippage on the shares.
      </p>
    </div>
  );
}

function WindowsWidget({ result }: { result: OverlayResult }) {
  const w = result.windows;
  if (!w) return null;
  const rows: Array<[string, OverlayWindow]> = [
    [`Train · to ${formatDay(w.split)}`, w.train],
    [`Test · from ${formatDay(w.split)}`, w.test],
  ];
  return (
    <Widget
      title="Train and test"
      meta="The same book on each side of the split day, after tax"
      wide
    >
      <Table>
        <THead>
          <Th dense>Window</Th>
          <Th align="right" dense>
            Weeks
          </Th>
          <Th align="right" dense>
            Total
          </Th>
          <Th align="right" dense>
            CAGR
          </Th>
          <Th align="right" dense>
            Drawdown
          </Th>
          <Th align="right" dense>
            Weekly 90 % range
          </Th>
          <Th align="right" dense>
            Trades
          </Th>
          <Th align="right" dense>
            Won
          </Th>
          <Th align="right" dense>
            Top 5 % share
          </Th>
        </THead>
        <tbody>
          {rows.map(([name, m]) => (
            <TRow key={name}>
              <Td dense>{name}</Td>
              <Td numeric align="right" dense>
                {formatInt(m.weeks)}
              </Td>
              <Td numeric align="right" dense>
                <Money value={m.total_rs} />
              </Td>
              <Td numeric align="right" dense>
                {formatPct(m.cagr, 1)}
              </Td>
              <Td numeric align="right" dense>
                {formatPct(m.max_dd, 0)}
              </Td>
              <Td numeric align="right" dense>
                {m.weekly_90
                  ? `${formatPct(m.weekly_90[0], 2)} to ${formatPct(m.weekly_90[1], 2)}`
                  : EMPTY}
              </Td>
              <Td numeric align="right" dense>
                {formatInt(m.trades)}
              </Td>
              <Td numeric align="right" dense>
                {formatPct(m.win_rate, 0)}
              </Td>
              <Td numeric align="right" dense>
                {formatPct(m.top5pct_share, 0)}
              </Td>
            </TRow>
          ))}
        </tbody>
      </Table>
    </Widget>
  );
}
