/**
 * The Today page's list cards (BL-102): one per shown list (VISIBLE_LIST_KEYS), answering "how is
 * the list doing?" before anything else, plus any extra card the page adds (Adaptive Tuned, the
 * T1 track). With several lists a card is a button that makes its list the page's focus, and the
 * focus list is outlined. Today's picks sit inside, collapsed; a card's `action` (its portfolio
 * stop and what it does) sits under its figures.
 *
 * Figures come from the read-out (`lib/rotationListCards.ts`); a day not yet scored shows a
 * dash, never a zero.
 */

import type { ReactNode } from 'react';

import { cn } from '../../../lib/cn';
import { EMPTY, formatDay, formatInr } from '../../../lib/format';
import { type ListCard, listCards } from '../../../lib/rotationListCards';
import { SEVERAL_LISTS_VISIBLE } from '../../../lib/rotationListNames';
import type { RotationBasket, RotationListKey, RotationSummary } from '../../../types/rotation';
import { pnlClass } from '../shared';

function tone(value: number | null): string {
  return value === null ? 'text-foreground' : pnlClass(value);
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs" title={hint}>
      <dt className="text-muted">{label}</dt>
      <dd className="metric text-foreground">{value}</dd>
    </div>
  );
}

/** "Today's 3 picks", or the day they were recorded when that is not today. */
function picksTitleFor(entryDay: string | null, today: string) {
  return (count: number) =>
    entryDay === today
      ? `Today's ${count} picks`
      : entryDay
        ? `${count} picks recorded for ${formatDay(entryDay)}`
        : `${count} picks`;
}

function ListCardView({
  card,
  focused,
  focusable,
  basket,
  picksTitle,
  onFocus,
  action,
}: {
  card: ListCard;
  focused: boolean;
  /** A button that makes the card's list the page's focus (several lists shown). */
  focusable: boolean;
  basket: RotationBasket | undefined;
  picksTitle: (count: number) => string;
  onFocus: () => void;
  action?: ReactNode;
}) {
  const picks = basket ? [...basket.core, ...basket.buy] : [];
  return (
    <section
      aria-label={`${card.name} list`}
      className={cn(
        'flex flex-col gap-2 rounded-xl border bg-surface p-4',
        focused && focusable ? 'border-primary ring-1 ring-primary/40' : 'border-border',
      )}
    >
      {focusable ? (
        <button
          type="button"
          onClick={onFocus}
          aria-pressed={focused}
          className="flex flex-col items-start gap-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex w-full items-center justify-between gap-2">
            <span className="text-sm font-semibold text-foreground">{card.name}</span>
            {focused ? <span className="text-[10px] font-medium text-primary">focus</span> : null}
          </span>
          <span className="text-xs text-muted">{card.note}</span>
        </button>
      ) : (
        <div className="flex flex-col items-start gap-0.5">
          <span className="text-sm font-semibold text-foreground">{card.name}</span>
          <span className="text-xs text-muted">{card.note}</span>
        </div>
      )}

      <div>
        <div className="text-[11px] text-faint">
          {card.latest ? `Latest scored day, ${formatDay(card.latest.day)}` : 'Latest scored day'}
        </div>
        <div className={cn('metric text-xl font-semibold', tone(card.latest?.total ?? null))}>
          {formatInr(card.latest?.total ?? null, { sign: true })}
        </div>
      </div>

      <dl className="space-y-1">
        <Figure
          label="Since the first day"
          value={formatInr(card.total, { sign: true })}
          hint="Gross, one lot a strategy, over the scored forward days."
        />
        <Figure label="Max drawdown" value={formatInr(card.maxDrawdown)} />
        {card.isBase ? null : (
          <Figure
            label="Against the fixed base"
            value={
              card.vsBase === null ? EMPTY : `${formatInr(card.vsBase, { sign: true })} / lot-day`
            }
            hint="The mean daily gap per lot, the list minus the fixed base. A description of the days so far, not a verdict: the registered read-out is at 60 sessions."
          />
        )}
      </dl>

      {action ? <div className="space-y-1.5 border-t border-border pt-2">{action}</div> : null}

      {picks.length > 0 ? (
        <details className="border-t border-border pt-2 text-xs">
          <summary className="cursor-pointer text-muted hover:text-foreground">
            {picksTitle(picks.length)}
          </summary>
          <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-foreground">
            {picks.map((p) => (
              <li key={p.name} className="flex gap-2">
                <span className="w-10 shrink-0 text-faint">{p.start}</span>
                <span className="truncate">{p.name}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

/** A card the page adds beside the shown lists' (Adaptive Tuned), with its own picks. */
export interface ExtraListCard {
  card: ListCard;
  basket: RotationBasket | undefined;
  /** The day those picks were recorded for. */
  entryDay: string | null;
  action?: ReactNode;
}

export function RotationListCards({
  summary,
  baskets,
  entryDay,
  today,
  focus,
  onFocus,
  action,
  extra = [],
}: {
  summary: RotationSummary | null;
  baskets: Partial<Record<RotationListKey, RotationBasket>> | undefined;
  /** The day those baskets were recorded for, and today (IST): picks are "today's" only when equal. */
  entryDay: string | null;
  today: string;
  focus: RotationListKey;
  onFocus: (key: RotationListKey) => void;
  /** Shown on the focus list's card: the page's (Core) portfolio stop. */
  action?: ReactNode;
  extra?: readonly ExtraListCard[];
}) {
  const cards = listCards(summary);
  const count = cards.length + extra.length;
  return (
    <div
      className={cn(
        'grid gap-4',
        count > 2 ? 'lg:grid-cols-3' : count === 2 ? 'max-w-4xl md:grid-cols-2' : 'max-w-md',
      )}
    >
      {cards.map((card) => {
        const key = card.key;
        return (
          <ListCardView
            key={card.id}
            card={card}
            focused={key === focus}
            focusable={SEVERAL_LISTS_VISIBLE}
            basket={key ? baskets?.[key] : undefined}
            picksTitle={picksTitleFor(entryDay, today)}
            onFocus={() => (key ? onFocus(key) : undefined)}
            action={key === focus ? action : undefined}
          />
        );
      })}
      {extra.map((x) => (
        <ListCardView
          key={x.card.id}
          card={x.card}
          focused={false}
          focusable={false}
          basket={x.basket}
          picksTitle={picksTitleFor(x.entryDay, today)}
          onFocus={() => undefined}
          action={x.action}
        />
      ))}
    </div>
  );
}
