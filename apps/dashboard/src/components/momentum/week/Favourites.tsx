'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useRef } from 'react';

import { cn } from '../../../lib/cn';
import { formatInt } from '../../../lib/format';
import { STATUS_LABEL } from '../../../lib/momentumFavourites';
import { tradingSleeves } from '../../../lib/momentumWeek';
import type { MomentumWeekCard } from '../../../types/momentum';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';

const STATUS_TONE = { invested: 'positive', paper: 'info', watching: 'neutral' } as const;

function cardSummary(card: MomentumWeekCard): string {
  if (card.blocked) return card.blocked;
  if (card.group && card.sleeves?.length) {
    const trading = card.sleeves.filter((s) => s.on_cadence).length;
    if (trading === 0) return 'No sleeve rebalances this week';
  }
  const trades = tradeSummary(card);
  const sleeves = tradingSleeves(card);
  // A group that follows every Friday trades one sleeve a week: say which.
  return sleeves.length > 0 && sleeves.length <= 2 ? `${sleeves.join(' + ')} · ${trades}` : trades;
}

function tradeSummary(card: MomentumWeekCard): string {
  const sells = card.rows.filter((r) => ['SELL', 'TRIM'].includes(r.action)).length;
  const buys = card.rows.filter((r) => ['BUY', 'ADD', 'TOP UP'].includes(r.action)).length;
  if (!sells && !buys) return 'No trades this week';
  return [
    sells ? `${formatInt(sells)} sell${sells === 1 ? '' : 's'}` : null,
    buys ? `${formatInt(buys)} buy${buys === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function FavouriteTile({
  card,
  selected,
  onSelect,
}: {
  card: MomentumWeekCard;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'flex shrink-0 snap-start flex-col rounded-xl border bg-surface px-3.5 py-3 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        card.headline ? 'w-80' : 'w-60',
        selected ? 'border-primary bg-primary/5 ring-1 ring-inset ring-primary' : 'border-border',
      )}
    >
      <span className="flex flex-wrap items-center gap-1.5">
        {card.status ? (
          <Badge tone={STATUS_TONE[card.status]}>{STATUS_LABEL[card.status]}</Badge>
        ) : null}
        {card.headline ? <Badge tone="primary">Headline · sent to Telegram</Badge> : null}
      </span>
      <span className="mt-2 truncate text-sm font-semibold text-foreground" title={card.name}>
        {card.name}
      </span>
      <span className="truncate text-xs text-faint">
        {card.group ? `group of ${card.sleeves?.length ?? 0} · ` : ''}
        {card.dataset}
      </span>
      <span className="mt-2 flex justify-between gap-2 text-xs">
        <span className="text-muted">This week</span>
        <span
          className={cn('truncate text-right', card.blocked ? 'text-warning' : 'text-foreground')}
          title={cardSummary(card)}
        >
          {cardSummary(card)}
        </span>
      </span>
      <span className="mt-1 flex justify-between gap-2 text-xs">
        <span className="text-muted">{card.headline ? 'Holds' : 'Same names as headline'}</span>
        <span className="metric text-foreground">
          {card.headline
            ? card.blocked || !card.run
              ? '—'
              : `${formatInt(card.held.length)} names`
            : card.shared_with_headline == null
              ? '—'
              : `${formatInt(card.shared_with_headline)} of ${formatInt(card.held.length)}`}
        </span>
      </span>
    </button>
  );
}

/**
 * Every favourite (BL-051): the headline first and larger, then the rest in a row that scrolls
 * sideways. A click shows that favourite's table below; Paper, Invested and Watching filter it.
 */
export function FavouritesCarousel({
  cards,
  selectedId,
  onSelect,
  followed,
}: {
  cards: readonly MomentumWeekCard[] | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  followed: number | null;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const scroll = (direction: 1 | -1) =>
    scroller.current?.scrollBy({ left: direction * 520, behavior: 'smooth' });
  return (
    <Card flush>
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
        <h2 className="text-sm font-semibold text-foreground">Favourites</h2>
        <span className="text-xs text-muted">
          {cards ? `${formatInt(cards.length)} · ` : ''}
          {followed != null ? `Paper + Invested ${followed} of 8 · ` : ''}every one journalled each
          Friday
        </span>
        <span className="ml-auto flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            aria-label="Scroll favourites left"
            onClick={() => scroll(-1)}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Scroll favourites right"
            onClick={() => scroll(1)}
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </span>
      </div>
      <div ref={scroller} className="flex snap-x gap-2.5 overflow-x-auto px-4 pb-3 pt-2">
        {cards ? (
          cards.length ? (
            cards.map((card) => (
              <FavouriteTile
                key={card.id}
                card={card}
                selected={card.id === selectedId}
                onSelect={() => onSelect(card.id)}
              />
            ))
          ) : (
            <p className="py-3 text-sm text-muted">
              No favourites yet. Mark saved runs as favourites (Watching, Paper or Invested) on
              Saved runs.
            </p>
          )
        ) : (
          Array.from({ length: 4 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholders
            <Skeleton key={i} className="h-32 w-60 shrink-0 rounded-xl" />
          ))
        )}
      </div>
    </Card>
  );
}
