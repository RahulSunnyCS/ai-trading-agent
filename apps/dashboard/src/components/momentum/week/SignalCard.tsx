'use client';

import { Fragment, useMemo } from 'react';

import { cn } from '../../../lib/cn';
import { formatDay, formatInt, formatIstDateTime, formatPct } from '../../../lib/format';
import { STATUS_LABEL } from '../../../lib/momentumFavourites';
import { type StockScore, markKey } from '../../../lib/momentumScores';
import {
  SECTION_LABEL,
  groupRows,
  rankDelta,
  roomToExit,
  sleeveLabel,
  tradingSleeves,
} from '../../../lib/momentumWeek';
import type { MomentumWeekCard } from '../../../types/momentum';
import { Badge } from '../../ui/Badge';
import { Card } from '../../ui/Card';
import { THead, TRow, Table, Td, Th } from '../../ui/Table';
import { ScoreStrip } from '../scores/ScoreStrip';

const ACTION_TONE: Record<string, 'positive' | 'negative' | 'warning' | 'neutral'> = {
  BUY: 'positive',
  ADD: 'positive',
  'TOP UP': 'positive',
  SELL: 'negative',
  TRIM: 'warning',
  HOLD: 'neutral',
};

/**
 * The selected favourite's week (BL-051): its sleeves (a group), then one table grouped Sell /
 * Buy / Hold with the Scores strip, the rank and its change, the room left before the exit rank
 * (when the strategy has a single one) and the share after the trades. A row opens the Scores
 * stock drawer when the name is a scored stock.
 */
export function SignalCard({
  card,
  scores,
  lookbacks,
  onStock,
}: {
  card: MomentumWeekCard;
  scores: ReadonlyMap<string, StockScore> | null;
  lookbacks: readonly number[];
  onStock: (symbol: string) => void;
}) {
  const sections = useMemo(() => groupRows(card.rows), [card.rows]);
  const showExit = card.exit_rank != null;
  return (
    <Card flush>
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
        <h2 className="text-base font-semibold text-foreground">{card.name}</h2>
        {card.status ? <Badge tone="info">{STATUS_LABEL[card.status]}</Badge> : null}
        {card.headline ? <Badge tone="primary">Headline · Telegram</Badge> : null}
        <span className="text-xs text-muted">
          {card.run
            ? `${card.run === 'final' ? 'Final' : 'Preview'} · recorded ${card.recorded_at ? formatIstDateTime(card.recorded_at) : ''}`
            : ''}
        </span>
        <span className="ml-auto text-xs text-muted">
          <b className="text-foreground">{formatInt(card.trades)}</b> trades ·{' '}
          <b className="text-foreground">{formatInt(card.held.length)}</b> held after
          {card.cash != null && card.cash > 0.0005 ? ` · cash ${formatPct(card.cash)}` : ''}
        </span>
      </div>
      {card.sleeves?.length ? (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pt-2">
          <span className="mr-1 text-xs text-faint">Sleeves:</span>
          {card.sleeves.map((sleeve) => (
            <span
              key={sleeve.id}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs',
                sleeve.on_cadence
                  ? 'border-primary/50 bg-primary/10 text-foreground'
                  : 'border-border bg-surface-2 text-muted',
              )}
            >
              <span className="metric font-semibold">{sleeveLabel(sleeve.name, card.name)}</span>
              {sleeve.on_cadence ? (
                <Badge tone="info">trades</Badge>
              ) : sleeve.next ? (
                <span className="text-faint">next {formatDay(sleeve.next)}</span>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
      {(card.sleeves?.length ?? 0) > 1 && tradingSleeves(card).length > 0 ? (
        <p className="px-4 pt-2 text-xs text-muted">
          This Friday {tradingSleeves(card).join(' and ')} trade
          {tradingSleeves(card).length === 1 ? 's' : ''}; the other sleeves hold. Orders are shown
          as shares of the whole group.
        </p>
      ) : null}
      {card.explain ? <p className="px-4 pt-2 text-xs text-muted">{card.explain}</p> : null}
      {card.blocked ? (
        <p className="px-4 py-4 text-sm text-warning">{card.blocked}</p>
      ) : card.rows.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted">Nothing held and nothing to trade this week.</p>
      ) : (
        <div className="mt-2">
          <Table>
            <THead>
              <Th>Action</Th>
              <Th>Name</Th>
              {card.group ? <Th>Sleeves</Th> : null}
              <Th align="right">Rank</Th>
              <Th align="right">Δ wk</Th>
              <Th>Score 1w … 52w</Th>
              {showExit ? <Th align="right">Room to exit ({card.exit_rank})</Th> : null}
              <Th align="right">After</Th>
            </THead>
            <tbody>
              {sections.map(({ section, rows }) => (
                <Fragment key={section}>
                  <tr>
                    <td
                      colSpan={6 + (card.group ? 1 : 0) + (showExit ? 1 : 0)}
                      className="px-3 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-faint"
                    >
                      {SECTION_LABEL[section]} · {formatInt(rows.length)}
                    </td>
                  </tr>
                  {rows.map((row) => {
                    const stock = scores?.get(markKey(row.asset)) ?? null;
                    const delta = rankDelta(row);
                    const room = roomToExit(row, card.exit_rank);
                    return (
                      <TRow
                        key={row.asset}
                        onClick={stock ? () => onStock(stock.symbol) : undefined}
                      >
                        <Td>
                          <Badge tone={ACTION_TONE[row.action] ?? 'neutral'}>
                            {row.action || '—'}
                          </Badge>
                        </Td>
                        <Td className="max-w-64">
                          <span className="font-semibold text-foreground">{row.asset}</span>
                          {stock ? (
                            <span className="ml-1.5 text-xs text-faint">{stock.parent_group}</span>
                          ) : null}
                        </Td>
                        {card.group ? (
                          <Td className="text-xs text-muted">
                            {row.sleeves?.length
                              ? `${formatInt(row.sleeves.length)} of ${formatInt(card.sleeves?.length ?? 0)}`
                              : '—'}
                          </Td>
                        ) : null}
                        <Td align="right" numeric>
                          {row.rank == null ? '—' : formatInt(row.rank)}
                        </Td>
                        <Td
                          align="right"
                          numeric
                          className={
                            delta == null || delta === 0
                              ? 'text-faint'
                              : delta > 0
                                ? 'text-positive'
                                : 'text-negative'
                          }
                        >
                          {delta == null
                            ? '—'
                            : delta === 0
                              ? '–'
                              : `${delta > 0 ? '▲' : '▼'}${formatInt(Math.abs(delta))}`}
                        </Td>
                        <Td>
                          {stock ? (
                            <ScoreStrip
                              scores={stock.scores}
                              lookbacks={lookbacks}
                              returns={stock.returns}
                            />
                          ) : (
                            <span className="text-xs text-faint">not a scored stock</span>
                          )}
                        </Td>
                        {showExit ? (
                          <Td
                            align="right"
                            numeric
                            className={
                              room == null
                                ? 'text-faint'
                                : room < 0
                                  ? 'text-negative'
                                  : room <= 3
                                    ? 'text-warning'
                                    : 'text-positive'
                            }
                          >
                            {room == null
                              ? '—'
                              : room < 0
                                ? 'past exit'
                                : `${formatInt(room)} to go`}
                          </Td>
                        ) : null}
                        <Td align="right" numeric>
                          {row.after != null && row.after > 0 ? formatPct(row.after) : '—'}
                        </Td>
                      </TRow>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </Table>
        </div>
      )}
      <p className="px-4 py-2.5 text-xs text-faint">
        {card.group
          ? 'After = the name’s share of the whole group, each sleeve weighted by its value since the April reset. Ranks are each sleeve’s own.'
          : showExit
            ? `Room to exit counts the places left before rank ${card.exit_rank}, where a held name is sold.`
            : 'This strategy sells on more than one rank (its category and pool), so no single room-to-exit figure is shown.'}
      </p>
    </Card>
  );
}
