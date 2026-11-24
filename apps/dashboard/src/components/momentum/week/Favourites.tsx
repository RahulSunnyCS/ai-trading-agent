'use client';

import { useState } from 'react';

import { cn } from '../../../lib/cn';
import { EMPTY, formatDay, formatInt, formatPct } from '../../../lib/format';
import { STATUS_LABEL } from '../../../lib/momentumFavourites';
import { favouriteRow } from '../../../lib/momentumWeek';
import type { MomentumWeekCard } from '../../../types/momentum';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';
import { THead, TRow, Table, Td, Th } from '../../ui/Table';

const STATUS_TONE = { invested: 'positive', paper: 'info', watching: 'neutral' } as const;

type SinceStart = NonNullable<MomentumWeekCard['since_start']>;
type Measured = Exclude<SinceStart, { error: string }>;

/** The figures when the favourite was measured; null for a Watching one, or one that could not be. */
function measured(card: MomentumWeekCard): Measured | null {
  const value = card.since_start;
  return value && 'return' in value ? value : null;
}

const tone = (value: number) => (value < 0 ? 'text-negative' : 'text-positive');

function HeadlineCard({
  card,
  selected,
  onSelect,
}: {
  card: MomentumWeekCard;
  selected: boolean;
  onSelect: () => void;
}) {
  const row = favouriteRow(card);
  const edge = card.edge;
  const since = measured(card);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'mx-4 flex w-[calc(100%-2rem)] flex-col gap-1.5 rounded-xl border bg-surface px-3.5 py-3 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected ? 'border-primary bg-primary/5 ring-1 ring-inset ring-primary' : 'border-border',
      )}
    >
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        {card.status ? (
          <Badge tone={STATUS_TONE[card.status]}>{STATUS_LABEL[card.status]}</Badge>
        ) : null}
        <Badge tone="primary">Headline · sent to Telegram</Badge>
        <span className="min-w-0 truncate text-sm font-semibold text-foreground" title={card.name}>
          {card.name}
        </span>
        <span className="text-xs text-faint">
          {card.group ? `group of ${card.sleeves?.length ?? 0} · ` : ''}
          {card.dataset}
        </span>
      </span>
      <span className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {card.blocked ? (
          <span className="text-warning">{card.blocked}</span>
        ) : (
          <span className="text-foreground">
            This week {row.sleeve ? <b>{row.sleeve}</b> : (row.noSleeve ?? row.trades)}
          </span>
        )}
        {since ? (
          <span className="text-foreground">
            Since {formatDay(since.start)}{' '}
            <b className={cn('metric', tone(since.return))}>
              {formatPct(since.return, 1, { sign: true })}
            </b>{' '}
            · worst fall <b className="metric text-negative">{formatPct(since.max_drawdown)}</b> ·{' '}
            {formatInt(since.weeks)} week{since.weeks === 1 ? '' : 's'}
          </span>
        ) : null}
        <span className="text-muted">
          Holds {card.blocked || !card.run ? EMPTY : `${formatInt(card.held.length)} names`}
        </span>
        {edge?.sleeve ? (
          <span className="text-muted">
            Next sleeve: {edge.sleeve}
            {edge.on ? ` on ${formatDay(edge.on)}` : ''}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** "K of N" with a bar, the names a favourite holds that the headline holds too. */
function SharedBar({ shared, held }: { shared: number | null; held: number }) {
  if (shared == null || held === 0) {
    return (
      <span className="text-faint" title="Nothing held to compare yet">
        {EMPTY}
      </span>
    );
  }
  const share = Math.max(0, Math.min(1, shared / held));
  return (
    <span className="flex items-center gap-2">
      <span className="metric w-14 shrink-0 text-xs text-foreground">
        {formatInt(shared)} of {formatInt(held)}
      </span>
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
        <span
          className="block h-full rounded-full bg-primary"
          style={{ width: `${share * 100}%` }}
        />
      </span>
    </span>
  );
}

/**
 * Every favourite (BL-051): the headline as its card, the rest as a dense table under it, one row
 * each, with the return and worst fall since your start (the lots put in the way yours were, from
 * the Friday rules job). A click picks the favourite Names at the edge follows.
 */
export function Favourites({
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
  const headline = cards?.find((card) => card.headline) ?? null;
  const others = (cards ?? []).filter((card) => card !== headline);
  // Paper and Invested favourites are the ones that matter for money; the Watching ones sit behind
  // a toggle (and show whenever one of them is the card picked below).
  const [showWatching, setShowWatching] = useState(false);
  const watching = others.filter((card) => card.status === 'watching');
  const watchingPicked = watching.some((card) => card.id === selectedId);
  const open = showWatching || watchingPicked;
  const first = (cards ?? []).map(measured).find((value) => value !== null);
  const sinceLabel = first ? formatDay(first.start) : 'start';
  const listed = open ? others : others.filter((card) => card.status !== 'watching');
  return (
    <Card flush>
      <div className="flex flex-wrap items-center gap-2 px-4 pb-2 pt-3">
        <h2 className="text-sm font-semibold text-foreground">Favourites</h2>
        <span className="text-xs text-muted">
          {cards ? `${formatInt(cards.length)} · ` : ''}
          {followed != null ? `Paper + Invested ${followed} of 8 · ` : ''}every one journalled each
          Friday
        </span>
      </div>
      {!cards ? (
        <div className="space-y-2 px-4 pb-3">
          <Skeleton className="h-20 w-full rounded-xl" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : !cards.length ? (
        <p className="px-4 pb-3 text-sm text-muted">
          No favourites yet. Mark saved runs as favourites (Watching, Paper or Invested) on Saved
          runs.
        </p>
      ) : (
        <>
          {headline ? (
            <HeadlineCard
              card={headline}
              selected={headline.id === selectedId}
              onSelect={() => onSelect(headline.id)}
            />
          ) : null}
          {listed.length ? (
            <div className="mt-2">
              <Table>
                <THead>
                  <Th dense className="pl-4">
                    {headline ? 'Other favourites' : 'Favourites'}
                  </Th>
                  <Th dense>This week</Th>
                  <Th dense align="right">
                    Return since {sinceLabel}
                  </Th>
                  <Th dense align="right">
                    Worst fall
                  </Th>
                  <Th dense>Same names as headline</Th>
                  <Th dense className="pr-4">
                    <span className="sr-only">Open</span>
                  </Th>
                </THead>
                <tbody>
                  {listed.map((card) => (
                    <FavouriteRow
                      key={card.id}
                      card={card}
                      selected={card.id === selectedId}
                      onSelect={() => onSelect(card.id)}
                    />
                  ))}
                </tbody>
              </Table>
            </div>
          ) : null}
          {watching.length && !watchingPicked ? (
            <div className="px-4 pt-2">
              <Button size="sm" variant="ghost" onClick={() => setShowWatching((value) => !value)}>
                {showWatching
                  ? 'Hide the watching favourites'
                  : `Show ${formatInt(watching.length)} watching favourite${watching.length === 1 ? '' : 's'}`}
              </Button>
            </div>
          ) : null}
          <div className="h-3" />
        </>
      )}
    </Card>
  );
}

function FavouriteRow({
  card,
  selected,
  onSelect,
}: {
  card: MomentumWeekCard;
  selected: boolean;
  onSelect: () => void;
}) {
  const row = favouriteRow(card);
  const thisWeek = card.blocked ?? row.sleeve ?? row.noSleeve ?? EMPTY;
  const since = measured(card);
  const why =
    card.since_start && 'error' in card.since_start
      ? card.since_start.error
      : 'Only Paper and Invested favourites are measured since your start';
  return (
    <TRow onClick={onSelect} selected={selected} className="h-8">
      <Td dense className="max-w-72 pl-4">
        <span className="flex min-w-0 items-center gap-1.5">
          {card.status ? (
            <Badge tone={STATUS_TONE[card.status]}>{STATUS_LABEL[card.status]}</Badge>
          ) : null}
          <span className="truncate whitespace-nowrap font-semibold" title={card.name}>
            {card.name}
          </span>
        </span>
      </Td>
      <Td
        dense
        className={cn(
          'max-w-56 truncate whitespace-nowrap text-xs',
          card.blocked ? 'text-warning' : 'text-muted',
        )}
        title={thisWeek === EMPTY ? 'A single strategy: no sleeves' : thisWeek}
      >
        {thisWeek}
      </Td>
      <Td
        dense
        align="right"
        numeric
        className={since ? tone(since.return) : 'text-faint'}
        title={since ? `${since.weeks} weeks, to ${formatDay(since.as_of)}` : why}
      >
        {since ? formatPct(since.return, 1, { sign: true }) : EMPTY}
      </Td>
      <Td
        dense
        align="right"
        numeric
        className={since ? 'text-negative' : 'text-faint'}
        title={since ? 'The deepest fall from a running peak since the start' : why}
      >
        {since ? formatPct(since.max_drawdown) : EMPTY}
      </Td>
      <Td dense>
        <SharedBar shared={card.shared_with_headline} held={card.held.length} />
      </Td>
      <Td dense className="whitespace-nowrap pr-4 text-xs text-faint">
        {selected ? 'selected' : 'select ▸'}
      </Td>
    </TRow>
  );
}
