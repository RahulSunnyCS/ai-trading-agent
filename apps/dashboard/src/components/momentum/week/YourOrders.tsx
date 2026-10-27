'use client';

import { Settings2 } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { usePolledResource } from '../../../hooks/usePolledResource';
import { apiPost, apiPut } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import {
  EMPTY,
  formatDay,
  formatInr,
  formatInt,
  formatIstDateTime,
  formatPct,
  formatPp,
} from '../../../lib/format';
import type {
  MomentumLotOrders,
  MomentumOrderPreview,
  MomentumOrderPreviewJob,
  MomentumOrderRow,
  MomentumOrderSettings,
  MomentumOrders,
  MomentumOrdersView,
} from '../../../types/momentum';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Drawer } from '../../ui/Drawer';
import { NumberField, Select, inputClass } from '../../ui/Input';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Skeleton } from '../../ui/Skeleton';
import { StateMessage } from '../../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../../ui/Table';
import { toast } from '../../ui/Toast';

const ACTION_TONE: Record<string, 'positive' | 'negative' | 'warning' | 'neutral'> = {
  SELL: 'negative',
  TRIM: 'warning',
  BUY: 'positive',
  ADD: 'positive',
  SKIP: 'neutral',
  HOLD: 'warning',
};

function Kpi({
  label,
  value,
  sub,
  tone,
}: { label: string; value: string; sub?: string | undefined; tone?: string | undefined }) {
  return (
    <div className="min-w-0 flex-1 basis-36 border-border px-4 py-3 sm:border-r last:border-r-0">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-faint">{label}</div>
      <div className={cn('metric mt-1 text-lg font-semibold', tone)}>{value}</div>
      {sub ? <div className="text-xs text-muted">{sub}</div> : null}
    </div>
  );
}

function OrderRow({ row }: { row: MomentumOrderRow }) {
  const drift = row.current - row.target;
  const muted = row.action === 'SKIP' || row.action === '';
  return (
    <TRow className={muted ? 'opacity-60' : ''}>
      <Td>
        {row.action ? (
          <Badge tone={ACTION_TONE[row.action] ?? 'neutral'}>{row.action}</Badge>
        ) : (
          <span className="text-faint">—</span>
        )}
      </Td>
      <Td className="font-semibold text-foreground">
        {row.symbol}
        {row.lot ? <span className="ml-1.5 text-xs font-normal text-faint">{row.lot}</span> : null}
      </Td>
      <Td align="right" numeric>
        {row.held ? formatInt(row.held) : '0'}
      </Td>
      <Td align="right" numeric>
        {row.value ? formatInr(row.value) : '—'}
      </Td>
      <Td align="right" numeric>
        {formatPct(row.current)}
      </Td>
      <Td align="right" numeric>
        {formatPct(row.target)}
      </Td>
      <Td
        align="right"
        numeric
        className={cn(
          'whitespace-nowrap',
          drift > 0.0005 ? 'text-warning' : drift < -0.0005 ? 'text-info' : 'text-faint',
        )}
      >
        {formatPp(drift)}
      </Td>
      <Td align="right" numeric className="font-semibold">
        {row.quantity
          ? `${row.action === 'SELL' || row.action === 'TRIM' ? '−' : '+'}${formatInt(row.quantity)}`
          : '—'}
      </Td>
      <Td align="right" numeric>
        {row.price ? formatInr(row.price, { dp: 2 }) : '—'}
      </Td>
      <Td align="right" numeric>
        {row.quantity ? formatInr(row.order_value) : '—'}
      </Td>
      <Td align="right" numeric>
        {row.quantity ? formatInr(row.charges) : '—'}
      </Td>
      <Td
        className={cn(
          'max-w-56 truncate whitespace-nowrap text-xs',
          row.action === 'HOLD' ? 'text-warning' : 'text-faint',
        )}
      >
        <span title={row.note}>{row.note}</span>
      </Td>
    </TRow>
  );
}

/** A favourite the "Preview for…" picker offers (This week's cards). */
export interface OrderPreviewChoice {
  id: string;
  name: string;
  headline: boolean;
}

/** What the plan table needs, from the stored orders or from a preview. */
type PlanSource = Pick<MomentumOrders, 'kind' | 'reason'> &
  Partial<Pick<MomentumOrders, 'plan' | 'prices' | 'holdings' | 'lots'>>;

/**
 * Your orders (BL-051 Phase 3): the headline's trades in whole shares against the paper
 * portfolio (until money goes in) or the holdings read from Kite or Fyers. Made by the Friday 14:15
 * job, or now with "Make orders". "Preview for…" shows another favourite's orders against the same
 * holdings, saved nowhere. Nothing here places an order.
 */
export function YourOrders({
  favourites = null,
}: { favourites?: readonly OrderPreviewChoice[] | null } = {}) {
  const view = usePolledResource<MomentumOrdersView>('/api/momentum/orders', { cache: true });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const running = view.data?.job?.status === 'running';
  const refetch = view.refetch;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(refetch, 4000);
    return () => clearInterval(timer);
  }, [running, refetch]);

  const latest: MomentumOrders | null = view.data?.orders.at(-1) ?? null;
  const settings = view.data?.settings ?? null;
  const preview = useOrderPreview();
  const others = useMemo(() => (favourites ?? []).filter((f) => !f.headline), [favourites]);
  const previewing = preview.favourite !== null;
  const previewName = others.find((f) => f.id === preview.favourite)?.name ?? null;

  async function makeOrders(): Promise<void> {
    const response = await apiPost('/api/momentum/orders/run', {});
    if (!response.ok) toast(`Could not make the orders: ${response.error}`, 'error');
    refetch();
  }

  return (
    <Card flush>
      <div id="orders" className="flex scroll-mt-4 flex-wrap items-center gap-2 px-4 pt-3">
        <h2 className="text-base font-semibold text-foreground">Your orders</h2>
        {previewing ? (
          <span className="text-xs text-muted">preview for {previewName ?? 'a favourite'}</span>
        ) : latest?.headline ? (
          <span className="text-xs text-muted">for {latest.headline.name}</span>
        ) : null}
        {settings ? (
          <Badge tone={settings.holdings_source === 'paper' ? 'info' : 'positive'}>
            {settings.holdings_source === 'paper'
              ? `Paper portfolio ${formatInr(settings.paper_capital_rs)}`
              : `Holdings from ${brokerName(settings.holdings_source)}`}
          </Badge>
        ) : null}
        {previewing ? (
          <Badge tone="warning">Preview · nothing saved</Badge>
        ) : latest && latest.kind !== 'unavailable' ? (
          <Badge tone={latest.kind === 'exact' ? 'primary' : 'neutral'}>
            {latest.kind === 'exact' ? 'Exact before the close' : 'From the final data'}
          </Badge>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5">
          {others.length ? (
            <Select
              aria-label="Preview for"
              className="h-8 w-56 py-0 text-xs"
              value={preview.favourite ?? ''}
              onChange={(event) => preview.select(event.target.value || null)}
            >
              <option value="">Headline: the orders made</option>
              {others.map((f) => (
                <option key={f.id} value={f.id}>
                  Preview for {f.name}
                </option>
              ))}
            </Select>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => setSettingsOpen(true)}>
            <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
            Settings
          </Button>
          {previewing ? null : (
            <Button size="sm" onClick={() => void makeOrders()} loading={running}>
              {running ? 'Making orders…' : 'Make orders now'}
            </Button>
          )}
        </span>
      </div>
      {!previewing && view.data?.job?.status === 'failed' ? (
        <p className="px-4 pt-2 text-xs text-negative">
          The last run failed: {view.data.job.error}
        </p>
      ) : null}

      {previewing ? (
        <PreviewBody state={preview} settings={settings} />
      ) : view.loading && !view.data ? (
        <LoadingBody />
      ) : view.error && !view.data ? (
        <div className="px-4 py-4">
          <StateMessage
            variant="error"
            title="Could not load your orders"
            description={view.error}
          />
        </div>
      ) : !latest ? (
        <p className="px-4 py-4 text-sm text-muted">
          No orders for the week of {view.data?.week}. The Friday 14:15 job makes them, or press{' '}
          <b>Make orders now</b>.
        </p>
      ) : (
        <PlanBody
          orders={latest}
          settings={settings}
          made={
            <>
              Made {formatIstDateTime(latest.created_at)} (
              {latest.trigger === 'scheduled' ? 'the 14:15 job' : 'by hand'}).
            </>
          }
          lots={latest.lots ? <LotsPanel orders={latest} /> : null}
        />
      )}
      <OrdersSettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        view={view.data ?? null}
        onChanged={refetch}
      />
    </Card>
  );
}

function LoadingBody() {
  return (
    <div className="space-y-2 px-4 py-4">
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

/** A preview's state, shown only when its job is the one asked for the favourite now picked. */
interface OrderPreviewState {
  favourite: string | null;
  select: (favourite: string | null) => void;
  /** Starts the picked favourite's preview again (after an error). */
  retry: () => void;
  /** The finished preview of the picked favourite, else null. */
  result: MomentumOrderPreview | null;
  loading: boolean;
  error: string | null;
}

/** Starts a read-only preview job for the picked favourite and polls it while it runs. */
function useOrderPreview(): OrderPreviewState {
  const [favourite, setFavourite] = useState<string | null>(null);
  const [job, setJob] = useState<{ favourite: string; id: string } | null>(null);
  const [startError, setStartError] = useState<{ favourite: string; error: string } | null>(null);
  const picked = useRef<string | null>(null);

  const select = useCallback((next: string | null) => {
    picked.current = next;
    setFavourite(next);
    setJob(null);
    setStartError(null);
    if (!next) return;
    void apiPost<MomentumOrderPreviewJob>('/api/momentum/orders/preview/jobs', {
      favourite: next,
    }).then((started) => {
      if (picked.current !== next) return; // another favourite was picked meanwhile
      if (started.ok) setJob({ favourite: next, id: started.data.id });
      else setStartError({ favourite: next, error: started.error });
    });
  }, []);

  const current = job && job.favourite === favourite ? job : null;
  const [finished, setFinished] = useState<string | null>(null);
  const polled = usePolledResource<MomentumOrderPreviewJob>(
    current ? `/api/momentum/orders/preview/jobs/${current.id}` : '',
    // Polled only while the job runs.
    current && finished !== current.id
      ? { enabled: true, intervalMs: 2000 }
      : { enabled: current !== null },
  );
  // Gate on the job asked for: the hook keeps the previous job's answer while the next loads.
  const data = current && polled.data?.id === current.id ? polled.data : null;
  // A job that finished, or that the service no longer knows (a restart): stop asking.
  const done =
    data && data.status !== 'running' ? data.id : current && polled.error ? current.id : null;
  useEffect(() => {
    if (done) setFinished(done);
  }, [done]);

  const error =
    startError && startError.favourite === favourite
      ? startError.error
      : data?.status === 'failed'
        ? (data.error ?? 'The preview failed.')
        : current && polled.error
          ? polled.error
          : null;
  return {
    favourite,
    select,
    retry: () => select(favourite),
    result: data?.status === 'done' ? data.result : null,
    loading: favourite !== null && !error && data?.status !== 'done',
    error,
  };
}

function PreviewBody({
  state,
  settings,
}: { state: OrderPreviewState; settings: MomentumOrderSettings | null }) {
  if (state.error) {
    return (
      <div className="px-4 py-4">
        <StateMessage
          variant="error"
          title="Could not make the preview"
          description={state.error}
        />
        <div className="mt-2 flex justify-center">
          <Button size="sm" onClick={state.retry}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  if (state.loading || !state.result) {
    return (
      <div className="space-y-2 px-4 py-4">
        <p className="text-xs text-muted">
          Planning this favourite against your holdings. A cold ranking can take a minute.
        </p>
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  const result = state.result;
  if (result.error) return <p className="px-4 py-4 text-sm text-warning">{result.error}</p>;
  if (!result.kind) return <p className="px-4 py-4 text-sm text-warning">No plan came back.</p>;
  return (
    <PlanBody
      orders={{ ...result, kind: result.kind, reason: result.reason ?? null }}
      settings={settings}
      made={
        <>
          {result.holdings?.source === 'paper'
            ? 'A preview: saved nowhere, and planned from your paper capital in cash (the paper portfolio is the headline’s). '
            : 'A preview: saved nowhere, and planned as one portfolio against all your holdings, never lot by lot. '}
          Your orders for the headline are unchanged.
        </>
      }
      lots={null}
    />
  );
}

/** The tiles, the orders table and the footer, for the stored orders or a preview. */
function PlanBody({
  orders,
  settings,
  made,
  lots,
}: {
  orders: PlanSource;
  settings: MomentumOrderSettings | null;
  made: ReactNode;
  lots: ReactNode;
}) {
  const plan = orders.plan ?? null;
  const trades = plan?.rows.filter((r) => r.quantity > 0).length ?? 0;
  if (!plan) return <p className="px-4 py-4 text-sm text-warning">{orders.reason}</p>;
  return (
    <>
      <div className="mt-2 flex flex-wrap border-y border-border">
        <Kpi
          label="Portfolio value"
          value={formatInr(plan.portfolio_value)}
          sub={`cash ${formatInr(plan.cash)} · prices: ${orders.prices ?? EMPTY}`}
        />
        <Kpi label="Sells" value={formatInr(plan.sells)} tone="text-negative" />
        <Kpi label="Buys" value={formatInr(plan.buys)} tone="text-positive" />
        <Kpi
          label="Cash after"
          value={formatInr(plan.cash_after)}
          tone={plan.cash_after < 0 ? 'text-negative' : undefined}
        />
        <Kpi label="Charges" value={formatInr(plan.charges)} sub="STT, stamp, exchange, DP" />
        <Kpi
          label="Not traded"
          value={formatInt(plan.not_traded)}
          sub={`under ${formatInr(settings?.min_trade_rs ?? 10_000)}, or held`}
        />
      </div>
      {lots}
      <Table>
        <THead>
          <Th>Order</Th>
          <Th>Name</Th>
          <Th align="right">You hold</Th>
          <Th align="right">Value</Th>
          <Th align="right">Yours</Th>
          <Th align="right">Model</Th>
          <Th align="right">Drift</Th>
          <Th align="right">Shares</Th>
          <Th align="right">Price</Th>
          <Th align="right">Order value</Th>
          <Th align="right">Charges</Th>
          <Th>Note</Th>
        </THead>
        <tbody>
          {plan.rows.map((row) => (
            <OrderRow key={`${row.lot ?? ''}-${row.symbol}`} row={row} />
          ))}
        </tbody>
      </Table>
      <p className="px-4 py-2.5 text-xs text-faint">
        {formatInt(trades)} orders, sells first. Whole shares, rounded down; top-ups and trims under{' '}
        {formatInr(settings?.min_trade_rs ?? 10_000)} are skipped, exits and new names always go
        through. {made}
        {plan.missing_prices.length ? ` No price for ${plan.missing_prices.join(', ')}.` : ''}
        {orders.holdings && orders.holdings.source !== 'paper' && orders.holdings.outside?.length
          ? ` Left alone, not part of this strategy: ${orders.holdings.outside.join(', ')}.`
          : ''}
      </p>
    </>
  );
}

const LOT_STATUS: Record<MomentumLotOrders['status'], string> = {
  new: 'New lot: buy',
  rebalance: 'Rebalance',
  exit: 'Sell only',
  'not due': 'Not due',
};

/** BL-142: the strategy followed lot by lot: what each lot does this Friday, what to add to Kite,
 * the one order per stock, and any change in Kite no lot could take. */
function LotsPanel({ orders }: { orders: MomentumOrders }) {
  const lots = orders.lots ?? [];
  const net = Object.entries(orders.net ?? {});
  const unexplained = orders.ledger?.unexplained ?? [];
  return (
    <div className="space-y-2 border-b border-border px-4 py-3 text-sm">
      <ul className="space-y-1">
        {lots.map((lot) => (
          <li key={lot.id} className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-semibold text-foreground">{lot.label}</span>
            <Badge tone={lot.status === 'not due' ? 'neutral' : 'primary'}>
              {LOT_STATUS[lot.status]}
            </Badge>
            {lot.budget != null && lot.status !== 'not due' ? (
              <span className="text-muted">{formatInr(lot.budget)}</span>
            ) : null}
            {lot.status === 'not due' && lot.next ? (
              <span className="text-muted">next {formatDay(lot.next)}</span>
            ) : null}
            <span className="text-xs text-faint">
              {Object.entries(lot.holds)
                .map(([name, shares]) => `${name} ${formatInt(shares)}`)
                .join(' · ') || 'holds nothing yet'}
            </span>
          </li>
        ))}
      </ul>
      {orders.deposit_needed ? (
        <p className="text-warning">
          Add <b>{formatInr(orders.deposit_needed)}</b> to Kite before you buy: the new lot needs{' '}
          {formatInr(orders.lot_size ?? 0)}.
        </p>
      ) : null}
      {net.length ? (
        <p className="text-muted">
          One order per stock:{' '}
          {net
            .map(([name, q]) => `${q > 0 ? 'BUY' : 'SELL'} ${name} ${formatInt(Math.abs(q))}`)
            .join(', ')}
        </p>
      ) : null}
      {unexplained.length ? (
        <p className="text-negative">
          Not in any lot (run <span className="font-mono">mbt lots assign SYMBOL --lot N</span>):{' '}
          {unexplained
            .map((u) => `${u.symbol} ${u.delta > 0 ? '+' : ''}${formatInt(u.delta)}`)
            .join(', ')}
        </p>
      ) : null}
    </div>
  );
}

function OrdersSettingsDrawer({
  open,
  onClose,
  view,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  view: MomentumOrdersView | null;
  onChanged: () => void;
}) {
  const settings = view?.settings ?? null;
  const [draft, setDraft] = useState<Partial<MomentumOrderSettings>>({});
  // The paper source keeps the Fyers button, as before Kite existed.
  const broker = settings?.holdings_source === 'kite' ? 'Kite' : 'Fyers';
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState(false);
  const value = <K extends keyof MomentumOrderSettings>(
    key: K,
  ): MomentumOrderSettings[K] | undefined =>
    (draft[key] as MomentumOrderSettings[K] | undefined) ?? settings?.[key];

  async function save(): Promise<void> {
    setBusy(true);
    const response = await apiPut('/api/momentum/orders/settings', draft);
    setBusy(false);
    if (!response.ok) {
      toast(`Not saved: ${response.error}`, 'error');
      return;
    }
    toast('Order settings saved');
    setDraft({});
    onChanged();
  }

  async function sync(): Promise<void> {
    setBusy(true);
    const response = await apiPost('/api/momentum/holdings/sync', {});
    setBusy(false);
    if (!response.ok) toast(`Could not read ${broker}: ${response.error}`, 'error');
    else toast(`Holdings read from ${broker}`);
    onChanged();
  }

  async function savePaste(): Promise<void> {
    setBusy(true);
    const response = await apiPost('/api/momentum/holdings/paste', { text: paste });
    setBusy(false);
    if (!response.ok) {
      toast(response.error, 'error');
      return;
    }
    toast('Holdings saved');
    setPaste('');
    onChanged();
  }

  async function setRule(symbol: string, treatment: 'exclude' | 'cash' | null): Promise<void> {
    const response = await apiPut('/api/momentum/holdings/rules', { symbol, treatment });
    if (!response.ok) toast(response.error, 'error');
    onChanged();
  }

  const number = (
    key: 'min_trade_rs' | 'paper_capital_rs' | 'extra_cash_rs' | 'lot_size_rs',
    label: string,
  ) => (
    <div className="block text-sm">
      <span className="text-xs text-muted">{label}</span>
      <NumberField
        aria-label={label}
        min={0}
        step={1000}
        value={Number(value(key) ?? 0)}
        onChange={(next) => setDraft((d) => ({ ...d, [key]: next }))}
        className="mt-1"
      />
    </div>
  );

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => (next ? undefined : onClose())}
      title="Your orders: settings"
      subtitle="Saved for your owner ID. Nothing here places an order."
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <div className="text-xs text-muted">Orders are made against</div>
          <SegmentedControl
            ariaLabel="Holdings source"
            size="sm"
            value={value('holdings_source') ?? 'paper'}
            onChange={(next) => setDraft((d) => ({ ...d, holdings_source: next }))}
            options={[
              { value: 'paper', label: 'Paper portfolio' },
              { value: 'fyers', label: 'Holdings from Fyers' },
              { value: 'kite', label: 'Holdings from Kite' },
            ]}
          />
          <p className="text-xs text-muted">
            Paper: the model portfolio at your paper capital, until money goes in. Fyers or Kite:
            what your account holds, read-only, at 14:15 and when you press Sync. Kite also reads
            the account&apos;s free cash, which the orders use. LIQUIDBEES and gold bonds (SGB) are
            options margin and always left out.
          </p>
        </div>
        {number('paper_capital_rs', 'Paper capital (₹)')}
        {number('lot_size_rs', 'A new weekly lot is funded with (₹)')}
        {number('min_trade_rs', 'Skip top-ups and trims smaller than (₹)')}
        {number('extra_cash_rs', 'Cash for the strategy held outside the broker (₹)')}
        <Button
          variant="primary"
          onClick={() => void save()}
          disabled={busy || Object.keys(draft).length === 0}
        >
          Save settings
        </Button>

        <div className="border-t border-border pt-4">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">Holdings</h3>
            <span className="text-xs text-muted">
              {view?.holdings
                ? `${view.holdings.source === 'paste' ? 'pasted' : `from ${brokerName(view.holdings.source)}`} · ${formatIstDateTime(view.holdings.synced_at)}`
                : 'none saved yet'}
              {view?.holdings?.cash != null ? ` · free cash ${formatInr(view.holdings.cash)}` : ''}
            </span>
            <Button size="sm" className="ml-auto" onClick={() => void sync()} disabled={busy}>
              Sync from {broker}
            </Button>
          </div>
          {view?.holdings?.rows.length ? (
            <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
              {view.holdings.rows.map((row) => {
                const margin = isMarginSymbol(row.symbol, view.margin);
                const rule = view.rules[row.symbol] ?? null;
                return (
                  <li key={row.symbol} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                    <span className="w-28 truncate font-semibold text-foreground">
                      {row.symbol}
                    </span>
                    <span className="metric text-xs text-muted">{formatInt(row.quantity)} sh</span>
                    {margin ? (
                      // Options margin is always left out (BL-142): no rule can change it.
                      <span className="ml-auto text-xs text-faint">
                        Options margin · always left out
                      </span>
                    ) : (
                      <span className="ml-auto">
                        <SegmentedControl
                          ariaLabel={`How ${row.symbol} counts`}
                          size="sm"
                          value={rule ?? 'use'}
                          onChange={(next) =>
                            void setRule(row.symbol, next === 'use' ? null : next)
                          }
                          options={[
                            { value: 'use', label: 'Use' },
                            { value: 'exclude', label: 'Exclude' },
                            { value: 'cash', label: 'As cash' },
                          ]}
                        />
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}
          <label className="mt-3 block text-xs text-muted">
            Or paste <span className="font-mono">SYMBOL quantity</span>, one per line (when {broker}{' '}
            cannot be read)
            <textarea
              value={paste}
              onChange={(event) => setPaste(event.target.value)}
              rows={4}
              className={cn(inputClass, 'mt-1 font-mono text-xs')}
              placeholder={'SBIN 10\nHAL 12'}
            />
          </label>
          <Button
            size="sm"
            className="mt-2"
            onClick={() => void savePaste()}
            disabled={busy || !paste.trim()}
          >
            Save pasted holdings
          </Button>
        </div>
      </div>
    </Drawer>
  );
}

function brokerName(source: 'fyers' | 'kite'): string {
  return source === 'kite' ? 'Kite' : 'Fyers';
}

/** LIQUIDBEES and sovereign gold bonds are options margin, left out with no rule (BL-142). */
function isMarginSymbol(symbol: string, margin: MomentumOrdersView['margin']): boolean {
  if (!margin) return false;
  return margin.symbols.includes(symbol) || margin.prefixes.some((p) => symbol.startsWith(p));
}
