/**
 * The Today page's Books table (dashboard review, 2026-10-28): Adaptive Classic, Adaptive Tuned
 * and the Fixed base as three rows, replacing the three list cards and the headline strip, which
 * said the same figures twice and pushed the chart below the first screen. Each row keeps its own
 * portfolio stop (the same button and dialog as before); what the stop changed opens under the row
 * on request, and is offered only once the replay is in. The registered verdict sits under it.
 *
 * Figures are `lib/rotationBooks.ts`'s; a day not yet scored is a dash, never a zero.
 */

import { Fragment, type ReactNode, useState } from 'react';

import { cn } from '../../../lib/cn';
import { EMPTY, formatDay, formatInr, formatPct } from '../../../lib/format';
import type { PortfolioStopSetting } from '../../../lib/portfolioStop';
import { type BookRow, stopChanged, stopSummary } from '../../../lib/rotationBooks';
import type { StopEffect } from '../../../lib/rotationPortfolioView';
import { InfoTooltip } from '../../ui/InfoTooltip';
import { THead, TRow, Table, Td, Th } from '../../ui/Table';
import { PortfolioStopButton } from '../PortfolioStopButton';
import { pnlClass } from '../shared';
import { StopEffectBlock } from './StopEffect';

export interface BookStop {
  setting: PortfolioStopSetting;
  onChange: (next: PortfolioStopSetting) => void;
  defaults: PortfolioStopSetting;
  /** The dialog's title, e.g. "Portfolio stop · Adaptive Tuned". */
  title: string;
  /** What the stop changed over the book's scored days; null until the replay is in. */
  effect: StopEffect | null;
  /** A short line while the replay is running or failed, with its full sentence; null otherwise. */
  status: { text: string; detail: string } | null;
}

export interface BookLine {
  row: BookRow;
  name: string;
  note: string;
  /** The book every chart and widget below follows. */
  focus: boolean;
  stop: BookStop;
  /** Why the book has no figures yet, or why it could not be read. */
  message?: { text: string; error: boolean } | null;
}

function money(v: number | null, sign = true) {
  return formatInr(v, { sign });
}

function tone(v: number | null) {
  return v === null ? 'text-muted' : pnlClass(v);
}

function StopCell({
  stop,
  open,
  onToggle,
}: { stop: BookStop; open: boolean; onToggle: () => void }) {
  const s = stopSummary(stop.effect);
  return (
    <span className="flex items-center gap-2 whitespace-nowrap">
      <PortfolioStopButton
        setting={stop.setting}
        onChange={stop.onChange}
        defaults={stop.defaults}
        dialogTitle={stop.title}
        compact
      />
      {s ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="text-[11px] text-muted underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title="What the stop changed, with and without it"
        >
          {s.fired === 0 ? `not fired in ${s.days} days` : `fired ${s.fired} of ${s.days} days`}
          {s.change !== 0 ? ` · ${formatInr(s.change, { sign: true })}` : ''}
          {s.skipped > 0 ? ` · ${s.skipped} not counted` : ''}
        </button>
      ) : stop.status ? (
        <span className="text-[11px] text-muted" aria-live="polite" title={stop.status.detail}>
          {stop.status.text}
        </span>
      ) : null}
    </span>
  );
}

export function RotationBooks({
  lines,
  vsHeader,
  footer,
}: {
  lines: readonly BookLine[];
  /** "vs base", "vs random median": what the gap column is measured against. */
  vsHeader: string;
  /** The registered verdict, under the table. */
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const first = lines.find((l) => l.focus)?.row.firstDay ?? lines[0]?.row.firstDay ?? null;

  return (
    <section aria-label="Books" className="rounded-xl border border-border bg-surface shadow-card">
      <Table>
        <THead>
          <Th dense>Book</Th>
          <Th dense align="right">
            Latest day
          </Th>
          <Th dense align="right">
            {first ? `Since ${formatDay(first)}` : 'Since the first day'}
          </Th>
          <Th dense align="right">
            ₹ / lot-day
          </Th>
          <Th dense align="right">
            <span className="inline-flex items-center gap-1">
              Max DD / lot
              <InfoTooltip
                label="About max drawdown"
                text="The largest fall of the running total per lot from its peak, the peak starting at zero: the unit the registered rule compares. Hover a figure for the basket's drawdown in rupees."
              />
            </span>
          </Th>
          <Th dense align="right">
            <span className="inline-flex items-center gap-1">
              {vsHeader} / lot-day
              <InfoTooltip
                label="About the gap"
                text="The book's ₹ per lot-day minus the benchmark's, over the same scored days. A description of the days so far, not a verdict: the registered read-out is at 60 sessions."
              />
            </span>
          </Th>
          <Th dense align="right">
            <span className="inline-flex items-center gap-1">
              Beats random
              <InfoTooltip
                label="About beats random"
                text="Share of 1,000 random baskets of the same shape that the book's cumulative gross is above. Always on the registered basis, without a portfolio stop."
              />
            </span>
          </Th>
          <Th dense>Portfolio stop</Th>
        </THead>
        <tbody>
          {lines.map((l) => {
            const r = l.row;
            const isOpen = open.has(r.id) && l.stop.effect !== null;
            return (
              <Fragment key={r.id}>
                <TRow className={cn(l.focus && 'bg-primary/5')}>
                  <Td dense className="max-w-[18rem]">
                    <span className="flex items-baseline gap-2">
                      <span className="whitespace-nowrap font-medium text-foreground">
                        {l.name}
                      </span>
                      {l.focus ? <span className="text-[10px] text-primary">focus</span> : null}
                    </span>
                    <span className="block truncate text-[11px] text-faint" title={l.note}>
                      {l.message ? (
                        <span className={l.message.error ? 'text-negative' : 'text-muted'}>
                          {l.message.text}
                        </span>
                      ) : (
                        l.note
                      )}
                    </span>
                  </Td>
                  <Td
                    dense
                    align="right"
                    numeric
                    className={tone(r.latest?.total ?? null)}
                    title={r.latest ? formatDay(r.latest.day) : undefined}
                  >
                    {money(r.latest?.total ?? null)}
                  </Td>
                  <Td
                    dense
                    align="right"
                    numeric
                    className={tone(r.total)}
                    title={
                      r.firstDay && r.firstDay !== first
                        ? `From ${formatDay(r.firstDay)}, ${r.scoredDays} scored days`
                        : `${r.scoredDays} scored days`
                    }
                  >
                    {money(r.total)}
                    {r.firstDay && first && r.firstDay !== first ? (
                      <span className="ml-1 text-[10px] text-faint">
                        from {formatDay(r.firstDay)}
                      </span>
                    ) : null}
                  </Td>
                  <Td dense align="right" numeric className={tone(r.perLotDay)}>
                    {money(r.perLotDay)}
                  </Td>
                  <Td
                    dense
                    align="right"
                    numeric
                    className="whitespace-nowrap"
                    title={
                      r.maxDrawdown !== null
                        ? `${money(r.maxDrawdown, false)} for the basket at 1 lot a strategy`
                        : undefined
                    }
                  >
                    {money(r.maxDrawdownPerLot, false)}
                  </Td>
                  <Td dense align="right" numeric className={tone(r.vsBenchmark)}>
                    {r.id === 'BASE' ? (
                      <span className="text-faint">{r.total === null ? EMPTY : 'the base'}</span>
                    ) : (
                      money(r.vsBenchmark)
                    )}
                  </Td>
                  <Td dense align="right" numeric>
                    {r.beatsRandom === null
                      ? EMPTY
                      : formatPct(r.beatsRandom, 0, { unit: 'percent' })}
                  </Td>
                  <Td dense>
                    <StopCell stop={l.stop} open={isOpen} onToggle={() => toggle(r.id)} />
                  </Td>
                </TRow>
                {isOpen && l.stop.effect ? (
                  <tr className="border-b border-border bg-surface-2/40">
                    <td colSpan={8} className="px-3 py-2">
                      <div className={cn('max-w-xl', !stopChanged(l.stop.effect) && 'opacity-80')}>
                        <StopEffectBlock effect={l.stop.effect} />
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </Table>
      {footer ? <div className="border-t border-border px-4 py-3">{footer}</div> : null}
    </section>
  );
}
