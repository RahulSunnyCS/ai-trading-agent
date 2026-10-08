'use client';

import { Settings2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { usePolledResource } from '../../../hooks/usePolledResource';
import { apiPost, apiPut } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import { formatInr, formatInt, formatIstDateTime, formatPct, formatPp } from '../../../lib/format';
import type {
  MomentumOrderRow,
  MomentumOrderSettings,
  MomentumOrders,
  MomentumOrdersView,
} from '../../../types/momentum';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Drawer } from '../../ui/Drawer';
import { NumberField, inputClass } from '../../ui/Input';
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
      <Td className="font-semibold text-foreground">{row.symbol}</Td>
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

/**
 * Your orders (BL-051 Phase 3): the headline's trades in whole shares against the paper
 * portfolio (until money goes in) or the holdings read from Fyers. Made by the Friday 14:15 job,
 * or now with "Make orders". Nothing here places an order.
 */
export function YourOrders() {
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
  const plan = latest?.plan ?? null;
  const settings = view.data?.settings ?? null;
  const trades = useMemo(() => plan?.rows.filter((r) => r.quantity > 0).length ?? 0, [plan]);

  async function makeOrders(): Promise<void> {
    const response = await apiPost('/api/momentum/orders/run', {});
    if (!response.ok) toast(`Could not make the orders: ${response.error}`, 'error');
    refetch();
  }

  return (
    <Card flush>
      <div id="orders" className="flex scroll-mt-4 flex-wrap items-center gap-2 px-4 pt-3">
        <h2 className="text-base font-semibold text-foreground">Your orders</h2>
        {latest?.headline ? (
          <span className="text-xs text-muted">for {latest.headline.name}</span>
        ) : null}
        {settings ? (
          <Badge tone={settings.holdings_source === 'paper' ? 'info' : 'positive'}>
            {settings.holdings_source === 'paper'
              ? `Paper portfolio ${formatInr(settings.paper_capital_rs)}`
              : 'Holdings from Fyers'}
          </Badge>
        ) : null}
        {latest && latest.kind !== 'unavailable' ? (
          <Badge tone={latest.kind === 'exact' ? 'primary' : 'neutral'}>
            {latest.kind === 'exact' ? 'Exact before the close' : 'From the final data'}
          </Badge>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setSettingsOpen(true)}>
            <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
            Settings
          </Button>
          <Button size="sm" onClick={() => void makeOrders()} loading={running}>
            {running ? 'Making orders…' : 'Make orders now'}
          </Button>
        </span>
      </div>
      {view.data?.job?.status === 'failed' ? (
        <p className="px-4 pt-2 text-xs text-negative">
          The last run failed: {view.data.job.error}
        </p>
      ) : null}

      {view.loading && !view.data ? (
        <div className="space-y-2 px-4 py-4">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
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
      ) : !plan ? (
        <p className="px-4 py-4 text-sm text-warning">{latest.reason}</p>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap border-y border-border">
            <Kpi
              label="Portfolio value"
              value={formatInr(plan.portfolio_value)}
              sub={`cash ${formatInr(plan.cash)} · prices: ${latest.prices}`}
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
                <OrderRow key={row.symbol} row={row} />
              ))}
            </tbody>
          </Table>
          <p className="px-4 py-2.5 text-xs text-faint">
            {formatInt(trades)} orders, sells first. Whole shares, rounded down; top-ups and trims
            under {formatInr(settings?.min_trade_rs ?? 10_000)} are skipped, exits and new names
            always go through. Made {formatIstDateTime(latest.created_at)} (
            {latest.trigger === 'scheduled' ? 'the 14:15 job' : 'by hand'}).
            {plan.missing_prices.length ? ` No price for ${plan.missing_prices.join(', ')}.` : ''}
          </p>
        </>
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
    if (!response.ok) toast(`Could not read Fyers: ${response.error}`, 'error');
    else toast('Holdings read from Fyers');
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

  const number = (key: 'min_trade_rs' | 'paper_capital_rs' | 'extra_cash_rs', label: string) => (
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
            ]}
          />
          <p className="text-xs text-muted">
            Paper: the model portfolio at your paper capital, until money goes in. Fyers: what your
            account holds, read-only, at 14:15 and when you press Sync.
          </p>
        </div>
        {number('paper_capital_rs', 'Paper capital (₹)')}
        {number('min_trade_rs', 'Skip top-ups and trims smaller than (₹)')}
        {number('extra_cash_rs', 'Cash for the strategy held outside Fyers (₹)')}
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
                ? `${view.holdings.source === 'fyers' ? 'from Fyers' : 'pasted'} · ${formatIstDateTime(view.holdings.synced_at)}`
                : 'none saved yet'}
            </span>
            <Button size="sm" className="ml-auto" onClick={() => void sync()} disabled={busy}>
              Sync from Fyers
            </Button>
          </div>
          {view?.holdings?.rows.length ? (
            <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
              {view.holdings.rows.map((row) => {
                const rule = view.rules[row.symbol] ?? null;
                return (
                  <li key={row.symbol} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                    <span className="w-28 truncate font-semibold text-foreground">
                      {row.symbol}
                    </span>
                    <span className="metric text-xs text-muted">{formatInt(row.quantity)} sh</span>
                    <span className="ml-auto">
                      <SegmentedControl
                        ariaLabel={`How ${row.symbol} counts`}
                        size="sm"
                        value={rule ?? 'use'}
                        onChange={(next) => void setRule(row.symbol, next === 'use' ? null : next)}
                        options={[
                          { value: 'use', label: 'Use' },
                          { value: 'exclude', label: 'Exclude' },
                          { value: 'cash', label: 'As cash' },
                        ]}
                      />
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <label className="mt-3 block text-xs text-muted">
            Or paste <span className="font-mono">SYMBOL quantity</span>, one per line (when Fyers
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
