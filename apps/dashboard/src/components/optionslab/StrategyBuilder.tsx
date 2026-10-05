/**
 * Options Lab → Strategy builder: an AlgoTest/Quantiply-style form over the
 * leg-wise schema (legwise/schema.py). Load a saved strategy or start fresh,
 * edit instrument/timing, legs (strike, SL, target, trail SL, re-entry, range
 * breakout) and the overall stop/target, then Validate, Backtest over the
 * collected Fyers days (nothing saved), or Save to strategies/legwise/<name>.yaml
 * — after which the evening run includes it.
 *
 * The form only shapes JSON; the Python schema is the validator and its
 * messages are shown verbatim.
 */

import { CheckCircle2, Copy, FlaskConical, Plus, Save, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { LEGWISE_API, useLegwiseResults, useLegwiseStrategies } from '../../hooks/useLegwise';
import { apiPost, apiPut } from '../../lib/api';
import { formatPnl } from '../../lib/format';
import {
  type BaselineComparison,
  compareToBaseline,
  lotsOf,
  statsOf,
} from '../../lib/legwiseStats';
import type {
  Amount,
  BacktestResponse,
  DayRow,
  Leg,
  LegwiseStrategy,
  ReEntry,
  Underlying,
} from '../../types/legwise';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { StatCard } from '../ui/StatCard';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import {
  CumulativeLines,
  Field,
  NumberInput,
  Select,
  TextInput,
  TradeLog,
  pnlClass,
} from './shared';

const UNDERLYINGS: readonly Underlying[] = [
  'NIFTY',
  'BANKNIFTY',
  'MIDCPNIFTY',
  'FINNIFTY',
  'SENSEX',
];
const STRIKE_TYPES = [
  'ITM3',
  'ITM2',
  'ITM1',
  'ATM',
  'OTM1',
  'OTM2',
  'OTM3',
  'OTM4',
  'OTM5',
  'OTM6',
  'OTM7',
  'OTM8',
  'OTM9',
  'OTM10',
] as const;

function newLeg(n: number): Leg {
  return {
    id: `leg${n}`,
    lots: 1,
    position: 'sell',
    option_type: n % 2 === 0 ? 'PE' : 'CE',
    expiry: 'weekly',
    strike: { strike_type: 'ATM' },
    stop_loss: { percent: 25 },
  };
}

function newStrategy(): LegwiseStrategy {
  return {
    id: 'my_strategy',
    underlying: 'NIFTY',
    entry_time: '09:20',
    exit_time: '15:15',
    square_off: 'partial',
    legs: [newLeg(1), newLeg(2)],
    overall: {},
    execution: { slippage_pct: 0, cost_per_order_inr: 0 },
  };
}

/** Drop keys whose value is undefined — the Python schema forbids nulls for optionals. */
function clean<T extends object>(o: T): T {
  return JSON.parse(JSON.stringify(o)) as T;
}

type Unit = 'off' | 'points' | 'percent';

function AmountEditor(props: {
  label: string;
  value: Amount | undefined;
  onChange: (a: Amount | undefined) => void;
}) {
  const unit: Unit =
    props.value?.points !== undefined
      ? 'points'
      : props.value?.percent !== undefined
        ? 'percent'
        : 'off';
  const num = props.value?.points ?? props.value?.percent;
  const set = (u: Unit, v: number | undefined) =>
    props.onChange(
      u === 'off' ? undefined : u === 'points' ? { points: v ?? 10 } : { percent: v ?? 25 },
    );
  return (
    <Field label={props.label}>
      <div className="flex gap-1.5">
        <Select<Unit>
          value={unit}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'points', label: 'Points' },
            { value: 'percent', label: '%' },
          ]}
          onChange={(u) => set(u, num)}
        />
        <NumberInput
          value={num}
          disabled={unit === 'off'}
          step={0.5}
          onChange={(v) => set(unit, v)}
        />
      </div>
    </Field>
  );
}

function ReEntryEditor(props: {
  label: string;
  value: ReEntry | undefined;
  onChange: (r: ReEntry | undefined) => void;
}) {
  const mode = props.value?.mode ?? 'off';
  return (
    <Field label={props.label}>
      <div className="flex gap-1.5">
        <Select<'off' | 'asap' | 'cost'>
          value={mode}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'cost', label: 'RE COST' },
            { value: 'asap', label: 'RE ASAP' },
          ]}
          onChange={(m) =>
            props.onChange(m === 'off' ? undefined : { mode: m, count: props.value?.count ?? 1 })
          }
        />
        <NumberInput
          value={props.value?.count}
          disabled={mode === 'off'}
          onChange={(c) => props.value && props.onChange({ ...props.value, count: c ?? 1 })}
          className="w-16"
        />
      </div>
    </Field>
  );
}

function LegEditor(props: {
  leg: Leg;
  index: number;
  onChange: (leg: Leg) => void;
  onRemove: () => void;
  onCopy: () => void;
}) {
  const { leg, onChange } = props;
  const set = <K extends keyof Leg>(key: K, value: Leg[K]) => onChange({ ...leg, [key]: value });
  const byPremium = leg.strike.closest_premium !== undefined;
  const trailUnit: Unit = leg.trail_sl?.points
    ? 'points'
    : leg.trail_sl?.percent
      ? 'percent'
      : 'off';
  const trail = leg.trail_sl?.points ?? leg.trail_sl?.percent;
  const setTrail = (u: Unit, xy: [number, number] | undefined) =>
    set(
      'trail_sl',
      u === 'off'
        ? undefined
        : u === 'points'
          ? { points: xy ?? [10, 5] }
          : { percent: xy ?? [10, 5] },
    );
  const rb = leg.range_breakout;

  return (
    <div className="rounded-lg border border-border bg-surface-2/30 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-faint">
          Leg {props.index + 1}
        </span>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={props.onCopy} aria-label="Copy leg">
            <Copy className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={props.onRemove} aria-label="Remove leg">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Id">
          <TextInput value={leg.id} onChange={(v) => set('id', v)} className="w-20" />
        </Field>
        <Field label="Lots">
          <NumberInput value={leg.lots} onChange={(v) => set('lots', v ?? 1)} className="w-16" />
        </Field>
        <Field label="Position">
          <Select
            value={leg.position}
            options={['sell', 'buy'] as const}
            onChange={(v) => set('position', v)}
          />
        </Field>
        <Field label="Option">
          <Select
            value={leg.option_type}
            options={['CE', 'PE'] as const}
            onChange={(v) => set('option_type', v)}
          />
        </Field>
        <Field label="Expiry">
          <Select
            value={leg.expiry}
            options={[
              { value: 'weekly', label: 'Weekly' },
              { value: 'next_weekly', label: 'Next weekly' },
              { value: 'monthly', label: 'Monthly' },
            ]}
            onChange={(v) => set('expiry', v)}
          />
        </Field>
        <Field label="Strike">
          <div className="flex gap-1.5">
            <Select<'type' | 'premium'>
              value={byPremium ? 'premium' : 'type'}
              options={[
                { value: 'type', label: 'Strike type' },
                { value: 'premium', label: 'Closest premium' },
              ]}
              onChange={(m) =>
                set('strike', m === 'premium' ? { closest_premium: 50 } : { strike_type: 'ATM' })
              }
            />
            {byPremium ? (
              <NumberInput
                value={leg.strike.closest_premium}
                onChange={(v) => set('strike', { closest_premium: v ?? 50 })}
              />
            ) : (
              <Select
                value={(leg.strike.strike_type ?? 'ATM') as (typeof STRIKE_TYPES)[number]}
                options={STRIKE_TYPES}
                onChange={(v) => set('strike', { strike_type: v })}
              />
            )}
          </div>
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <AmountEditor
          label="Stop loss"
          value={leg.stop_loss}
          onChange={(a) => set('stop_loss', a)}
        />
        <AmountEditor label="Target" value={leg.target} onChange={(a) => set('target', a)} />
        <Field label="Trail SL (every X move SL by Y)">
          <div className="flex gap-1.5">
            <Select<Unit>
              value={trailUnit}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'points', label: 'Points' },
                { value: 'percent', label: '%' },
              ]}
              onChange={(u) => setTrail(u, trail)}
            />
            <NumberInput
              value={trail?.[0]}
              disabled={trailUnit === 'off'}
              onChange={(x) => setTrail(trailUnit, [x ?? 1, trail?.[1] ?? 1])}
              className="w-16"
            />
            <NumberInput
              value={trail?.[1]}
              disabled={trailUnit === 'off'}
              onChange={(y) => setTrail(trailUnit, [trail?.[0] ?? 1, y ?? 1])}
              className="w-16"
            />
          </div>
        </Field>
        <ReEntryEditor
          label="Re-entry on SL"
          value={leg.reentry_on_sl}
          onChange={(r) => set('reentry_on_sl', r)}
        />
        <ReEntryEditor
          label="Re-entry on target"
          value={leg.reentry_on_target}
          onChange={(r) => set('reentry_on_target', r)}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex items-center gap-2 pb-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={rb !== undefined}
            onChange={(e) =>
              set(
                'range_breakout',
                e.target.checked
                  ? { until: '09:45', side: 'high', source: 'instrument' }
                  : undefined,
              )
            }
          />
          Range breakout
        </label>
        {rb && (
          <>
            <Field label="Range until">
              <TextInput
                type="time"
                value={rb.until}
                onChange={(v) => set('range_breakout', { ...rb, until: v })}
              />
            </Field>
            <Field label="Break of">
              <Select
                value={rb.side}
                options={[
                  { value: 'high', label: 'High' },
                  { value: 'low', label: 'Low' },
                ]}
                onChange={(v) => set('range_breakout', { ...rb, side: v })}
              />
            </Field>
            <Field label="Range on">
              <Select
                value={rb.source}
                options={[
                  { value: 'instrument', label: 'Option premium' },
                  { value: 'underlying', label: 'Index' },
                ]}
                onChange={(v) => set('range_breakout', { ...rb, source: v })}
              />
            </Field>
          </>
        )}
      </div>
    </div>
  );
}

function BacktestResult({
  result,
  lots,
  baseline,
}: {
  result: BacktestResponse;
  lots: number;
  /** The saved version's stored ₹/lot per day, when one is loaded and has results. */
  baseline: Map<string, number> | null;
}) {
  const [open, setOpen] = useState<string | null>(null);
  // Same divisor statsOf and compareToBaseline use, so every column is ₹ per lot.
  const perLot = lots > 0 ? lots : 1;
  const st = statsOf(result.days, lots);
  const cmp: BaselineComparison | null = baseline
    ? compareToBaseline(result.days, lots, baseline)
    : null;
  return (
    <Card>
      <CardHeader
        title="Backtest result"
        description={`${result.strategy_id} over ${st.days} collected days · ₹ per lot${
          st.thin ? ' · fewer than 20 days: ratios are noise' : ''
        }`}
      />
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Net / lot"
          value={formatPnl(st.total)}
          tone={st.total >= 0 ? 'positive' : 'negative'}
        />
        <StatCard label="Up days" value={`${st.up} / ${st.days}`} />
        <StatCard
          label="Expectancy"
          value={st.expectancy === null ? '—' : formatPnl(st.expectancy)}
          note="avg ₹ / day"
        />
        <StatCard
          label="Profit factor"
          value={st.profitFactor === null ? '—' : st.profitFactor.toFixed(2)}
          note={st.avgLoss === null ? 'no losing day' : `avg loss ${formatPnl(st.avgLoss)}`}
        />
        <StatCard
          label="Worst day"
          value={st.worst === null ? '—' : formatPnl(st.worst)}
          tone="negative"
          note={`losing streak ${st.longestLosingStreak}`}
        />
        <StatCard label="Max drawdown" value={formatPnl(st.maxDrawdown)} tone="negative" />
      </div>
      {cmp && cmp.shared > 0 && (
        <p className="mb-3 text-sm">
          <span className="text-muted">
            Versus the saved version over {cmp.shared} shared days:{' '}
          </span>
          <span className={pnlClass(cmp.deltaTotal)}>
            {formatPnl(cmp.deltaTotal)} per lot (
            {cmp.deltaTotal >= 0 ? 'edit did better' : 'edit did worse'})
          </span>
          {cmp.uncovered > 0 && (
            <span className="text-faint">
              {' '}
              · {cmp.uncovered} days have no stored result for the saved version and are not
              compared
            </span>
          )}
        </p>
      )}
      <CumulativeLines lines={[{ id: result.strategy_id, points: st.cumulative }]} />
      <Table>
        <THead>
          <Th>Day</Th>
          <Th align="right">Trades</Th>
          <Th align="right">Net / lot</Th>
          {cmp && cmp.shared > 0 && <Th align="right">Saved (₹/lot)</Th>}
          {cmp && cmp.shared > 0 && <Th align="right">Δ / lot</Th>}
          <Th align="right">Worst MTM / lot</Th>
          <Th>Note</Th>
        </THead>
        <tbody>
          {result.days.map((d: DayRow) => (
            <TRow key={d.day} className="cursor-pointer">
              <Td
                numeric
                className="whitespace-nowrap"
                onClick={() => setOpen(open === d.day ? null : d.day)}
              >
                {d.day} {open === d.day ? '▾' : '▸'}
              </Td>
              <Td align="right" numeric>
                {d.trades.length}
              </Td>
              <Td align="right" numeric className={pnlClass(d.net)}>
                {formatPnl(d.net / perLot)}
              </Td>
              {cmp && cmp.shared > 0 && (
                <Td align="right" numeric className="text-muted">
                  {cmp.byDay.has(d.day) ? formatPnl(cmp.byDay.get(d.day)?.saved ?? 0) : '—'}
                </Td>
              )}
              {cmp && cmp.shared > 0 && (
                <Td align="right" numeric className={pnlClass(cmp.byDay.get(d.day)?.delta ?? 0)}>
                  {cmp.byDay.has(d.day) ? formatPnl(cmp.byDay.get(d.day)?.delta ?? 0) : '—'}
                </Td>
              )}
              <Td align="right" numeric>
                {formatPnl(d.worst_mtm / perLot)}
              </Td>
              <Td className="text-xs text-muted">
                {[d.stopped_by, ...d.notes].filter(Boolean).join('; ')}
              </Td>
            </TRow>
          ))}
        </tbody>
      </Table>
      {open && (
        <div className="mt-4">
          <p className="mb-2 text-sm font-medium">Trades on {open}</p>
          <TradeLog trades={result.days.find((d) => d.day === open)?.trades ?? []} />
        </div>
      )}
    </Card>
  );
}

export function StrategyBuilder() {
  const saved = useLegwiseStrategies();
  const stored = useLegwiseResults();
  const [name, setName] = useState('my_strategy');
  const [s, setS] = useState<LegwiseStrategy>(newStrategy);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [messages, setMessages] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const [result, setResult] = useState<BacktestResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof LegwiseStrategy>(key: K, value: LegwiseStrategy[K]) =>
    setS({ ...s, [key]: value });
  const setLeg = (i: number, leg: Leg) =>
    set(
      'legs',
      s.legs.map((l, j) => (j === i ? leg : l)),
    );
  const payload = useMemo(
    () => clean({ ...s, no_reentry_after: s.no_reentry_after || undefined }),
    [s],
  );

  // The saved version's results are already stored (keyed by version hash), so comparing
  // an edit against them is free — a second backtest call would spend a credit.
  const baseline = useMemo(() => {
    const version = saved.data?.find((x) => x.name === name);
    if (!version) return null;
    const lots = lotsOf(version.strategy);
    const mine = (stored.data?.results ?? []).filter(
      (r) => r.strategy_id === version.strategy.id && r.strategy_sha === version.sha,
    );
    return mine.length ? new Map(mine.map((r) => [r.day, r.net / lots])) : null;
  }, [saved.data, stored.data, name]);

  function load(n: string) {
    const found = saved.data?.find((x) => x.name === n);
    if (!found) return;
    setName(found.name);
    setS({ ...newStrategy(), ...found.strategy, overall: found.strategy.overall ?? {} });
    setResult(null);
    setMessages(null);
  }

  async function validate() {
    const r = await apiPost<{ valid: boolean; errors: string[] }>(`${LEGWISE_API}/validate`, {
      strategy: payload,
    });
    setMessages(
      r.ok
        ? { ok: r.data.valid, lines: r.data.valid ? ['Valid'] : r.data.errors }
        : { ok: false, lines: [r.error] },
    );
  }

  async function backtest() {
    setBusy(true);
    setResult(null);
    const body: Record<string, unknown> = { strategy: payload };
    if (from) body.from = from;
    if (to) body.to = to;
    const r = await apiPost<BacktestResponse>(`${LEGWISE_API}/backtest`, body);
    setBusy(false);
    if (r.ok) {
      setResult(r.data);
      setMessages(null);
    } else setMessages({ ok: false, lines: r.error.split('; ') });
  }

  async function save() {
    const r = await apiPut<{ name: string }>(
      `${LEGWISE_API}/strategies/${encodeURIComponent(name)}`,
      {
        strategy: payload,
      },
    );
    setMessages(
      r.ok
        ? {
            ok: true,
            lines: [
              `Saved as strategies/legwise/${r.data.name}.yaml — the evening run now includes it`,
            ],
          }
        : { ok: false, lines: r.error.split('; ') },
    );
    if (r.ok) saved.refetch();
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Strategy"
          description="Leg-wise, AlgoTest-style. Backtests run on the 1-minute Fyers data collected so far."
          actions={
            <div className="flex items-center gap-2">
              <Select<string>
                value=""
                options={[
                  { value: '', label: 'Load saved…' },
                  ...(saved.data ?? []).map((x) => ({ value: x.name, label: x.name })),
                ]}
                onChange={load}
              />
              <Button
                size="sm"
                onClick={() => {
                  setS(newStrategy());
                  setName('my_strategy');
                  setResult(null);
                }}
              >
                New
              </Button>
            </div>
          }
        />
        <div className="flex flex-wrap items-end gap-3">
          <Field label="File name (a-z 0-9 _)">
            <TextInput value={name} onChange={setName} className="w-48" />
          </Field>
          <Field label="Strategy id">
            <TextInput value={s.id} onChange={(v) => set('id', v)} className="w-48" />
          </Field>
          <Field label="Index">
            <Select
              value={s.underlying}
              options={UNDERLYINGS}
              onChange={(v) => set('underlying', v)}
            />
          </Field>
          <Field label="Entry">
            <TextInput type="time" value={s.entry_time} onChange={(v) => set('entry_time', v)} />
          </Field>
          <Field label="Exit">
            <TextInput type="time" value={s.exit_time} onChange={(v) => set('exit_time', v)} />
          </Field>
          <Field label="No re-entry after">
            <TextInput
              type="time"
              value={s.no_reentry_after ?? ''}
              onChange={(v) => set('no_reentry_after', v || undefined)}
            />
          </Field>
          <Field label="Square off">
            <Select
              value={s.square_off}
              options={[
                { value: 'partial', label: 'Partial (only the leg)' },
                { value: 'complete', label: 'Complete (all legs)' },
              ]}
              onChange={(v) => set('square_off', v)}
            />
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Legs"
          actions={
            <Button size="sm" onClick={() => set('legs', [...s.legs, newLeg(s.legs.length + 1)])}>
              <Plus className="h-3.5 w-3.5" />
              Add leg
            </Button>
          }
        />
        <div className="space-y-3">
          {s.legs.map((leg, i) => (
            <LegEditor
              // biome-ignore lint/suspicious/noArrayIndexKey: legs have no stable identity (ids are user-edited and may repeat); every input is controlled, so a position key cannot leave stale input state behind
              key={i}
              leg={leg}
              index={i}
              onChange={(l) => setLeg(i, l)}
              onRemove={() =>
                set(
                  'legs',
                  s.legs.filter((_, j) => j !== i),
                )
              }
              onCopy={() => set('legs', [...s.legs, { ...leg, id: `${leg.id}_2` }])}
            />
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="Overall & execution" />
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Overall max loss (₹)">
            <NumberInput
              value={s.overall.stop_loss_inr}
              onChange={(v) => set('overall', { ...s.overall, stop_loss_inr: v })}
            />
          </Field>
          <Field label="Overall max profit (₹)">
            <NumberInput
              value={s.overall.target_inr}
              onChange={(v) => set('overall', { ...s.overall, target_inr: v })}
            />
          </Field>
          <Field label="Slippage %">
            <NumberInput
              value={s.execution.slippage_pct}
              step={0.1}
              onChange={(v) => set('execution', { ...s.execution, slippage_pct: v ?? 0 })}
            />
          </Field>
          <Field label="Cost per order (₹)">
            <NumberInput
              value={s.execution.cost_per_order_inr}
              onChange={(v) => set('execution', { ...s.execution, cost_per_order_inr: v ?? 0 })}
            />
          </Field>
        </div>
        <div className="mt-5 flex flex-wrap items-end gap-3 border-t border-border pt-4">
          <Field label="Backtest from (blank = all)">
            <TextInput type="date" value={from} onChange={setFrom} />
          </Field>
          <Field label="to">
            <TextInput type="date" value={to} onChange={setTo} />
          </Field>
          <Button onClick={() => void validate()}>
            <CheckCircle2 className="h-3.5 w-3.5" />
            Validate
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void backtest()}>
            <FlaskConical className="h-3.5 w-3.5" />
            {busy ? 'Running…' : 'Backtest'}
          </Button>
          <Button onClick={() => void save()}>
            <Save className="h-3.5 w-3.5" />
            Save
          </Button>
        </div>
        {messages && (
          <div className="mt-3 space-y-1">
            {messages.lines.map((l) => (
              <p key={l} className={`text-xs ${messages.ok ? 'text-positive' : 'text-negative'}`}>
                {l}
              </p>
            ))}
          </div>
        )}
      </Card>

      {result && (
        <BacktestResult
          result={result}
          lots={lotsOf(payload as LegwiseStrategy)}
          baseline={baseline}
        />
      )}
    </div>
  );
}
