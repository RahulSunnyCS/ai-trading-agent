/**
 * Options Lab → Correlation → "A day's basket": are the day's picks really different bets?
 *
 * One list's picks for one day (or the owner's fixed base) go through the same correlation
 * maths as the strategy picker: how alike the picks are, how often they lose on the same day, and
 * what holding them together draws down against running each alone. The figures come from
 * `GET /legwise/rotation/basket` (`rotation/basket.py`), which calls the code behind
 * `obt rotation corr`; nothing is computed here.
 *
 * In-sample: the window's days are days that have already happened. Gross, one lot per
 * strategy. A pick with no results is named and left out; a thin window is shown muted.
 */

import { useMemo, useState } from 'react';

import { useQueryState } from '../../../hooks/useQueryState';
import { useRotationBasket } from '../../../hooks/useRotationBasket';
import { MEASURE_LABEL, matrixOf, pairReadout, reorder } from '../../../lib/correlationView';
import { formatDay, formatInr, formatInt, formatNumber, formatPct } from '../../../lib/format';
import {
  BASKET_LIST_OPTIONS,
  BASKET_WINDOW_OPTIONS,
  asBasketList,
  asBasketWindow,
  customNames,
  drawdownSaving,
  familyWord,
  lossPairs,
  pairSummary,
  readingLine,
  sourceBadge,
  sourceNote,
} from '../../../lib/rotationBasketView';
import type { CorrelationResponse } from '../../../types/legwise';
import type { BasketPick, RotationBasketResponse } from '../../../types/rotationBasket';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Input } from '../../ui/Input';
import { RefreshButton } from '../../ui/RefreshButton';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { SkeletonRows } from '../../ui/Skeleton';
import { StatCard } from '../../ui/StatCard';
import { StateMessage } from '../../ui/StateMessage';
import { type Cell, CorrelationHeatmap } from './CorrelationHeatmap';
import { PairCard } from './CorrelationParts';

function PickRow({ p }: { p: BasketPick }) {
  return (
    <li
      className="flex h-8 items-center gap-3 border-t border-border text-xs first:border-t-0"
      title={`${p.index ?? ''} ${familyWord(p)} · ${p.lots} lots`}
    >
      <span className="w-12 shrink-0 font-mono text-faint">{p.start ?? '—'}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-foreground">{p.name}</span>
      <span className="w-16 shrink-0 text-muted">{familyWord(p)}</span>
      <span className="w-14 shrink-0 text-right font-mono text-muted">
        {p.composite === null ? '' : formatNumber(p.composite, 3)}
      </span>
      <span className="w-14 shrink-0 text-right font-mono text-faint">{p.lots} lots</span>
      {p.has_results ? null : <Badge tone="warning">no results</Badge>}
      {p.role === 'buy' ? <Badge tone="neutral">Buy add-on</Badge> : null}
    </li>
  );
}

function Picks({ b }: { b: RotationBasketResponse }) {
  const badge = sourceBadge(b.source, b.late);
  const core = [...b.picks.filter((p) => p.role === 'core')].sort(
    (x, y) => (x.start ?? '').localeCompare(y.start ?? '') || x.name.localeCompare(y.name),
  );
  const buy = b.picks.filter((p) => p.role === 'buy');
  return (
    <Card>
      <CardHeader
        title={
          b.list === 'BASE'
            ? 'The fixed base'
            : `List ${b.list} · ${b.weekday ?? ''} ${b.day ? formatDay(b.day) : ''}`
        }
        description={sourceNote(b.source, b.late)}
        actions={
          <span className="flex items-center gap-2">
            {b.overridden ? <Badge tone="warning">Widesl minimum applied</Badge> : null}
            <Badge tone={badge.tone}>{badge.label}</Badge>
          </span>
        }
      />
      <ul>
        {core.map((p) => (
          <PickRow key={p.name} p={p} />
        ))}
        {buy.map((p) => (
          <PickRow key={p.name} p={p} />
        ))}
      </ul>
      {b.notes.map((n) => (
        <p key={n} className="mt-2 text-xs text-muted">
          {n}
        </p>
      ))}
    </Card>
  );
}

function Windows({ b }: { b: RotationBasketResponse }) {
  const w = b.windows;
  return (
    <p className="text-xs text-faint">
      Days this basket has in common:{' '}
      <span className="font-mono">
        P1 {formatInt(w.P1.n_days ?? 0)} · P2 {formatInt(w.P2.n_days ?? 0)} · Last 63{' '}
        {formatInt(w.last63.n_days ?? 0)} · Forward {formatInt(w.forward.n_days ?? 0)}
      </span>
      {' · '}in use: {b.window.label}
      {b.window.from && b.window.to
        ? ` (${formatDay(b.window.from)} to ${formatDay(b.window.to)})`
        : ''}
    </p>
  );
}

function DrawdownBars({ r }: { r: CorrelationResponse }) {
  const basket = Math.abs(r.basket.max_dd);
  const parts = Math.abs(r.basket.sum_of_part_dds);
  const top = Math.max(basket, parts, 1);
  const saving = drawdownSaving(r);
  const row = (label: string, value: number, cls: string) => (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)_5.5rem] items-center gap-2 text-xs">
      <span className="text-muted">{label}</span>
      <div className="h-3 rounded bg-surface-2">
        <div className={`h-3 rounded ${cls}`} style={{ width: `${(value / top) * 100}%` }} />
      </div>
      <span className="text-right font-mono text-foreground">{formatInr(-value)}</span>
    </div>
  );
  return (
    <div className="space-y-2">
      {row('Held together', basket, 'bg-primary/70')}
      {row('Each run alone', parts, 'bg-border-strong')}
      <p className="text-xs text-muted">
        {saving === null
          ? 'No strategy drew down in this window.'
          : saving >= 0
            ? `${formatPct(saving / 100, 0)} shallower held together.`
            : `${formatPct(-saving / 100, 0)} deeper held together.`}{' '}
        One lot each; “alone” is the sum of each strategy’s own worst fall.
      </p>
    </div>
  );
}

function LossTogether({ b, r }: { b: RotationBasketResponse; r: CorrelationResponse }) {
  const pairs = useMemo(() => lossPairs(r, b.duplicates), [r, b.duplicates]);
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-faint">
              <th className="py-1.5 pr-3 font-medium">Pair</th>
              <th className="py-1.5 pr-3 text-right font-medium">Lost together</th>
              <th className="py-1.5 text-right font-medium">Correlation</th>
            </tr>
          </thead>
          <tbody>
            {pairs.map((p) => (
              <tr key={`${p.a}|${p.b}`} className="h-8 border-t border-border">
                <td className="py-1 pr-3 font-mono text-foreground">
                  {p.a} · {p.b}
                </td>
                <td className="py-1 pr-3 text-right font-mono text-foreground">
                  {formatInt(p.both)} of {formatInt(p.either)}
                  {p.share === null ? '' : ` · ${formatPct(p.share, 0)}`}
                </td>
                <td className="py-1 text-right font-mono text-muted">
                  {p.r === null ? '—' : formatNumber(p.r, 2, { sign: true })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">
        All {formatInt(r.names.length)} lost on the same day:{' '}
        <span className="font-mono text-foreground">
          {formatInt(b.all_lose_days)} of {formatInt(r.n_days)}
        </span>{' '}
        sessions. “Lost together” counts the days both lost out of the days either lost.
      </p>
    </div>
  );
}

function Figures({ b, r }: { b: RotationBasketResponse; r: CorrelationResponse }) {
  const [hover, setHover] = useState<Cell | null>(null);
  const [pinned, setPinned] = useState<Cell | null>(null);
  const matrix = useMemo(() => matrixOf(r, 'pearson'), [r]);
  const view = useMemo(() => reorder(matrix, r.names, r.order), [matrix, r.names, r.order]);
  const { average: avg, most: alike } = pairSummary(r, b.duplicates);
  const shown = hover ?? pinned;
  const pair = shown ? pairReadout(r, view.index[shown[0]] ?? 0, view.index[shown[1]] ?? 0) : null;
  return (
    <div className={`space-y-5 ${b.enough ? '' : 'opacity-70'}`} data-thin={!b.enough}>
      {b.enough ? null : (
        <StateMessage
          variant="empty"
          title={`${formatInt(b.n_days)} days is too few to read`}
          description={`A correlation over fewer than ${b.thin_days} days is an anecdote. The figures are shown so the page is not empty; they will firm up as days are recorded.`}
        />
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Common days"
          value={formatInt(r.n_days)}
          note={`${formatDay(r.days[0])} to ${formatDay(r.days[r.days.length - 1])}`}
        />
        <StatCard
          label="Average pair"
          value={formatNumber(avg, 2)}
          note={alike ? `most alike ${alike.a} ~ ${alike.b}` : undefined}
          hint="The mean correlation of daily P&L over every pair of the picks. Near 0 means they mostly do their own thing."
        />
        <StatCard
          label="Lost together"
          value={`${formatInt(b.all_lose_days)} of ${formatInt(r.n_days)}`}
          note={`${formatInt(b.any_lose_days)} days at least one lost`}
          hint="Sessions on which every pick lost, out of the sessions in the window."
        />
        <StatCard
          label="Basket vs its parts"
          value={r.basket.dd_ratio === null ? '—' : `${formatNumber(r.basket.dd_ratio, 2)}×`}
          note="max drawdown ÷ sum of each alone"
          hint="Below 1.00× the basket fell less than its parts added up."
        />
      </div>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Card>
          <CardHeader title="How alike are they?" description={MEASURE_LABEL.pearson} />
          <CorrelationHeatmap
            names={view.names}
            matrix={view.m}
            hover={hover}
            pinned={pinned}
            onHover={setHover}
            onPin={setPinned}
            ariaLabel={`Correlation of ${r.names.length} picks. Use the arrow keys to read a pair.`}
          />
        </Card>
        <PairCard pair={pair} pinned={hover === null && pinned !== null} />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Do they lose on the same days?" />
          <LossTogether b={b} r={r} />
        </Card>
        <Card>
          <CardHeader
            title="Basket drawdown vs the parts"
            description="Max drawdown on the cumulative P&L from a start of 0."
          />
          <DrawdownBars r={r} />
        </Card>
      </div>
      <p className="text-sm text-muted">{readingLine(b)}</p>
      <p className="text-xs text-faint">
        In-sample, gross, one lot of each strategy. The same figures as the strategy picker for the
        same names and dates.
      </p>
    </div>
  );
}

export function CorrelationBasket({
  onOpenCustom,
}: {
  /** Switch to the strategy picker with these names and dates already chosen. */
  onOpenCustom: (names: string[], range: { from?: string; to?: string }) => void;
}) {
  const [listQ, setListQ] = useQueryState('blist');
  const [dayQ, setDayQ] = useQueryState('bday');
  const [winQ, setWinQ] = useQueryState('bwin');
  const list = asBasketList(listQ);
  const window = asBasketWindow(winQ);
  const res = useRotationBasket({ list, day: dayQ ?? undefined, window });
  const b = res.data;
  const names = b ? customNames(b) : null;

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
          <div className="flex flex-col gap-1 text-xs text-muted">
            List
            <SegmentedControl
              value={list}
              options={BASKET_LIST_OPTIONS}
              onChange={(v) => setListQ(v === 'A' ? null : v)}
              ariaLabel="List"
              size="sm"
            />
          </div>
          <div className="flex flex-col gap-1 text-xs text-muted">
            Day
            <Input
              type="date"
              value={dayQ ?? ''}
              onChange={(e) => setDayQ(e.target.value || null)}
              disabled={list === 'BASE'}
              aria-label="Day"
              title={list === 'BASE' ? 'The base is the same every day' : 'Empty is the latest day'}
            />
          </div>
          <div className="flex flex-col gap-1 text-xs text-muted">
            Window
            <SegmentedControl
              value={window}
              options={BASKET_WINDOW_OPTIONS}
              onChange={(v) => setWinQ(v === 'P1' ? null : v)}
              ariaLabel="Window"
              size="sm"
            />
          </div>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            disabled={names === null || !b}
            title={
              names === null
                ? 'The fixed base’s Dir leg is not one of the strategies the picker lists'
                : 'Open these picks in the strategy picker'
            }
            onClick={() => {
              if (!b || !names) return;
              onOpenCustom(names, {
                ...(b.window.from ? { from: b.window.from } : {}),
                ...(b.window.to ? { to: b.window.to } : {}),
              });
            }}
          >
            Open as custom
          </Button>
          <RefreshButton onClick={res.refetch} loading={res.loading} />
        </div>
      </Card>

      {res.error && b === null ? (
        <StateMessage variant="error" title="No basket to show" description={res.error} />
      ) : b === null ? (
        <SkeletonRows rows={6} />
      ) : (
        <>
          <Picks b={b} />
          <Windows b={b} />
          {b.correlation === null ? (
            <StateMessage
              variant="empty"
              title="No figures for this window"
              description={b.reason ?? 'There are too few common days to correlate.'}
            />
          ) : (
            <Figures b={b} r={b.correlation} />
          )}
        </>
      )}
    </div>
  );
}
