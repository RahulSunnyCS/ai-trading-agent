'use client';

import { cn } from '../../../lib/cn';
import { EMPTY, formatDay, formatInt, formatPct } from '../../../lib/format';
import { STATUS_LABEL } from '../../../lib/momentumFavourites';
import { favouriteRow } from '../../../lib/momentumWeek';
import type { MomentumWeekCard } from '../../../types/momentum';
import { Badge } from '../../ui/Badge';
import { Card } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';
import { THead, TRow, Table, Td, Th } from '../../ui/Table';

const STATUS_TONE = { invested: 'positive', paper: 'info', watching: 'neutral' } as const;

/** A favourite's backtest figures, when the page already has them (a single saved run's own;
 * a group's blend lives on Saved runs and is not fetched here). */
export interface FavouriteKpis {
  cagr: number | null;
  max_drawdown: number | null;
}

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
            This week {row.sleeve ? <b>{row.sleeve}</b> : null}
            {row.sleeve ? ' · ' : ''}
            {row.noSleeve ?? row.trades}
          </span>
        )}
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
 * each. A click shows that favourite's signals below and its orders' table, as the cards did.
 */
export function Favourites({
  cards,
  selectedId,
  onSelect,
  followed,
  kpis,
}: {
  cards: readonly MomentumWeekCard[] | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  followed: number | null;
  kpis: ReadonlyMap<string, FavouriteKpis>;
}) {
  const headline = cards?.find((card) => card.headline) ?? null;
  const others = (cards ?? []).filter((card) => card !== headline);
  // CAGR and drawdown only when the page has them for at least one row (a group's are on Saved runs).
  const showKpis = others.some((card) => kpis.has(card.id));
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
          {others.length ? (
            <div className="mt-2">
              <Table>
                <THead>
                  <Th dense className="pl-4">
                    {headline ? 'Other favourites' : 'Favourites'}
                  </Th>
                  <Th dense>This week</Th>
                  <Th dense align="right">
                    Sells
                  </Th>
                  <Th dense align="right">
                    Buys
                  </Th>
                  <Th dense>Same names as headline</Th>
                  {showKpis ? (
                    <>
                      <Th dense align="right">
                        CAGR
                      </Th>
                      <Th dense align="right">
                        Max DD
                      </Th>
                    </>
                  ) : null}
                  <Th dense className="pr-4">
                    <span className="sr-only">Open</span>
                  </Th>
                </THead>
                <tbody>
                  {others.map((card) => (
                    <FavouriteRow
                      key={card.id}
                      card={card}
                      selected={card.id === selectedId}
                      onSelect={() => onSelect(card.id)}
                      kpis={showKpis ? (kpis.get(card.id) ?? null) : undefined}
                    />
                  ))}
                </tbody>
              </Table>
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
  kpis,
}: {
  card: MomentumWeekCard;
  selected: boolean;
  onSelect: () => void;
  /** undefined: the columns are not shown; null: shown, not at hand for this row. */
  kpis: FavouriteKpis | null | undefined;
}) {
  const row = favouriteRow(card);
  const thisWeek = card.blocked ?? row.sleeve ?? row.noSleeve ?? EMPTY;
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
      <Td dense align="right" numeric>
        {row.sells == null ? EMPTY : formatInt(row.sells)}
      </Td>
      <Td dense align="right" numeric>
        {row.buys == null ? EMPTY : formatInt(row.buys)}
      </Td>
      <Td dense>
        <SharedBar shared={card.shared_with_headline} held={card.held.length} />
      </Td>
      {kpis !== undefined ? (
        <>
          <Td
            dense
            align="right"
            numeric
            title={kpis ? undefined : "A group's blended figures are on Saved runs"}
          >
            {kpis?.cagr == null ? EMPTY : formatPct(kpis.cagr)}
          </Td>
          <Td
            dense
            align="right"
            numeric
            className="text-negative"
            title={kpis ? undefined : "A group's blended figures are on Saved runs"}
          >
            {kpis?.max_drawdown == null ? EMPTY : formatPct(kpis.max_drawdown)}
          </Td>
        </>
      ) : null}
      <Td dense className="whitespace-nowrap pr-4 text-xs text-faint">
        {selected ? 'shown below' : 'orders ▸'}
      </Td>
    </TRow>
  );
}
