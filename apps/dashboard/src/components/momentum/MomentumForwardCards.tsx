'use client';

import { AlertTriangle } from 'lucide-react';

import { usePolledResource } from '../../hooks/usePolledResource';
import { cn } from '../../lib/cn';
import {
  EMPTY,
  formatDay,
  formatInr,
  formatInt,
  formatIstDateTime,
  formatNumber,
  formatPct,
  formatPp,
} from '../../lib/format';
import type {
  FillRebalance,
  FillRow,
  FillStatus,
  ForwardGroup,
  ForwardItem,
  ForwardStatus,
  ForwardView,
} from '../../types/momentumForward';
import { Accordion } from '../ui/Accordion';
import { Badge, type Tone } from '../ui/Badge';
import { Card, CardHeader } from '../ui/Card';
import { SkeletonRows } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../ui/Table';

/**
 * Momentum › Journal, below the check (BL-024 Phases 2-3): each journalled signal scored against
 * the week after it, beside the backtest, and the real Kite fills of each lot's rebalance.
 */
export function MomentumForwardCards() {
  const forward = usePolledResource<ForwardView>('/api/momentum/journal/forward');
  if (forward.error) {
    return (
      <StateMessage
        variant="error"
        title="Could not load the forward score"
        description={forward.error}
      />
    );
  }
  if (!forward.data) {
    return (
      <Card>
        <SkeletonRows rows={4} />
      </Card>
    );
  }
  return (
    <>
      <ForwardScoreCard view={forward.data} />
      <RealFillsCard view={forward.data} />
    </>
  );
}

function signed(value: number | null): string {
  return formatPct(value, 2, { sign: true });
}

function returnTone(value: number | null): string {
  if (value == null) return 'text-muted';
  return value >= 0 ? 'text-positive' : 'text-negative';
}

const SCORE_BADGE: Record<ForwardStatus, { label: string; tone: Tone }> = {
  scored: { label: 'Scored', tone: 'positive' },
  waiting: { label: 'Waiting', tone: 'neutral' },
  mismatch: { label: 'Mismatch', tone: 'negative' },
  late: { label: 'Recorded late', tone: 'warning' },
  not_scored: { label: 'Not scored', tone: 'warning' },
};

function ForwardScoreCard({ view }: { view: ForwardView }) {
  const score = view.score;
  return (
    <Card>
      <CardHeader
        title="Forward score"
        description="What each journalled signal earned the week after it, against what the backtest says for the same week. Live is the signal's portfolio after the backtest's own costs, filled at Friday's close (ideal) and at Monday's open (achievable). The Friday 20:30 job scores the week just finished."
      />
      {!score ? (
        <p className="text-sm text-muted">
          Nothing scored yet. The Friday 20:30 job (or <code>mbt journal score</code>) scores a week
          once the week after it is recorded.
        </p>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-muted">
            Scored {formatIstDateTime(score.computed_at)} · {formatInt(score.scored_weeks.length)}{' '}
            week{score.scored_weeks.length === 1 ? '' : 's'} scored so far. "As recorded" is the
            change in the backtest that produced the two journal rows; "Today's code" re-runs the
            same settings now ({score.ranking_now}). Signals recorded before 28 Oct 2026 come from
            the ranking before BL-001 F6, so the two can differ.
          </p>
          <GroupTable groups={score.groups} />
          <Accordion
            title="Every favourite"
            defaultOpen={false}
            badge={<Badge tone="neutral">{formatInt(score.items.length)} signal-weeks</Badge>}
            description="One row per favourite and week. A mismatch (a recorded buy not held the week after, or a sell still held) is shown, never scored."
          >
            <ItemTable items={score.items} />
          </Accordion>
        </div>
      )}
    </Card>
  );
}

function GroupTable({ groups }: { groups: ForwardGroup[] }) {
  if (groups.length === 0) {
    return <p className="text-sm text-muted">No followed group has a scored week yet.</p>;
  }
  return (
    <Table>
      <THead>
        <Th>Week of</Th>
        <Th>Strategy</Th>
        <Th align="right">Live, Fri close</Th>
        <Th align="right">Live, Mon open</Th>
        <Th align="right">Backtest as recorded</Th>
        <Th align="right">Backtest, today's code</Th>
        <Th align="right">Gap</Th>
        <Th align="right">Mom30 TRI</Th>
        <Th>Status</Th>
      </THead>
      <tbody>
        {groups.map((group) => (
          <TRow key={`${group.group_id}-${group.week}`}>
            <Td className="whitespace-nowrap">{formatDay(group.week)}</Td>
            <Td className="font-medium text-foreground">{group.name}</Td>
            <Td align="right" numeric className={returnTone(group.live.ideal)}>
              {signed(group.live.ideal)}
            </Td>
            <Td align="right" numeric className={returnTone(group.live.achievable)}>
              {signed(group.live.achievable)}
            </Td>
            <Td align="right" numeric>
              {signed(group.backtest.recorded)}
            </Td>
            <Td align="right" numeric>
              {signed(group.backtest.now)}
            </Td>
            <Td align="right" numeric title="Live at Friday close minus the backtest as recorded">
              {formatPp(group.gap.recorded.ideal, 2)}
            </Td>
            <Td align="right" numeric>
              {signed(group.benchmark)}
            </Td>
            <Td>
              {group.status === 'scored' ? (
                <Badge tone="positive">Scored</Badge>
              ) : (
                <Badge tone="neutral">
                  {formatInt(group.scored)} / {formatInt(group.members)} sleeves
                </Badge>
              )}
            </Td>
          </TRow>
        ))}
      </tbody>
    </Table>
  );
}

function ItemTable({ items }: { items: ForwardItem[] }) {
  return (
    <Table>
      <THead>
        <Th>Week of</Th>
        <Th>Strategy</Th>
        <Th>Run</Th>
        <Th align="right">Live, Fri close</Th>
        <Th align="right">Live, Mon open</Th>
        <Th align="right">As recorded</Th>
        <Th align="right">Today's code</Th>
        <Th>Status</Th>
        <Th>Note</Th>
      </THead>
      <tbody>
        {items.map((item) => {
          const badge = SCORE_BADGE[item.status];
          const note =
            item.mismatches.length > 0
              ? item.mismatches.join('; ')
              : (item.reason ??
                item.backtest.recorded_note ??
                (item.corrections.length > 0
                  ? `${formatInt(item.corrections.length)} correction(s) after the fill`
                  : ''));
          return (
            <TRow key={`${item.config_id}-${item.run_kind}-${item.week}`}>
              <Td className="whitespace-nowrap">{formatDay(item.week)}</Td>
              <Td className="max-w-[18rem] truncate" title={item.name}>
                {item.name}
              </Td>
              <Td className="capitalize">{item.run_kind}</Td>
              <Td align="right" numeric className={returnTone(item.live.ideal)}>
                {signed(item.live.ideal)}
              </Td>
              <Td align="right" numeric className={returnTone(item.live.achievable)}>
                {signed(item.live.achievable)}
              </Td>
              <Td align="right" numeric>
                {signed(item.backtest.recorded)}
              </Td>
              <Td align="right" numeric>
                {signed(item.backtest.now)}
              </Td>
              <Td className="whitespace-nowrap">
                <Badge tone={badge.tone} dot>
                  {badge.label}
                </Badge>
              </Td>
              <Td className="max-w-[20rem] truncate text-xs text-muted" title={note}>
                {note}
              </Td>
            </TRow>
          );
        })}
      </tbody>
    </Table>
  );
}

const FILL_BADGE: Record<FillStatus, Tone> = {
  done: 'positive',
  'shares differ': 'warning',
  missed: 'negative',
  extra: 'warning',
  held: 'neutral',
};

function RealFillsCard({ view }: { view: ForwardView }) {
  const fills = view.fills;
  const rebalances = (fills?.groups ?? []).flatMap((group) =>
    group.rebalances.map((rebalance) => ({ group, rebalance })),
  );
  const outside = (fills?.groups ?? []).flatMap((group) => group.outside_lots);
  return (
    <Card>
      <CardHeader
        title="Real fills (Kite)"
        description="Each lot's rebalance from your contract notes, against the journal's signal and the 14:15 orders: what was missed, share differences, the fill against the model's Friday close and Monday open, and charges against the model's rates."
      />
      {view.fills_error ? (
        <p className="mb-3 flex items-center gap-1.5 text-sm text-warning">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {view.fills_error}
        </p>
      ) : null}
      {rebalances.length === 0 ? (
        <p className="text-sm text-muted">
          No real rebalance yet: fills appear once a lot is booked in the ledger (Your orders) and
          its contract note has arrived.
        </p>
      ) : (
        <div className="space-y-5">
          {rebalances.map(({ group, rebalance }) => (
            <RebalanceBlock
              key={`${rebalance.sleeve_id}-${rebalance.week}`}
              group={group.name}
              rebalance={rebalance}
            />
          ))}
          {outside.length > 0 ? (
            <p className="text-xs text-muted">
              Outside the lots (no lot books them):{' '}
              {outside
                .map(
                  (fill) =>
                    `${formatDay(fill.day)} ${fill.side} ${formatNumber(fill.qty, 0)} ${fill.symbol} at ${formatInr(fill.price, { dp: 2 })}`,
                )
                .join(' · ')}
            </p>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function bps(value: number | null): string {
  return value == null ? EMPTY : `${formatNumber(value, 0, { sign: true })} bps`;
}

function RebalanceBlock({ group, rebalance }: { group: string; rebalance: FillRebalance }) {
  const totals = rebalance.totals;
  return (
    <section aria-label={`${rebalance.lot}, week of ${formatDay(rebalance.week)}`}>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4 className="text-sm font-semibold text-foreground">
          {rebalance.lot} · week of {formatDay(rebalance.week)}
        </h4>
        <span className="text-xs text-muted">
          {group} · journal #{rebalance.entry_id}
          {rebalance.new_lot ? ' · new lot, bought from cash' : ''}
          {rebalance.first_trade_day ? ` · traded ${formatDay(rebalance.first_trade_day)}` : ''} ·
          budget {formatInr(rebalance.budget)} ({rebalance.budget_from})
        </span>
        {rebalance.booked_pending ? (
          <Badge tone="info">not booked in the ledger yet: matched by the 14:15 orders</Badge>
        ) : null}
      </div>
      {rebalance.plan_differs.length > 0 ? (
        <p className="mb-2 text-xs text-warning">
          The 14:15 orders and the journal's final signal disagree on{' '}
          {rebalance.plan_differs.join(', ')} (the orders decide on live prices before the close;
          the final on the close).
        </p>
      ) : null}
      <Table>
        <THead>
          <Th>Name</Th>
          <Th>Signal</Th>
          <Th align="right">Model shares</Th>
          <Th align="right">Orders</Th>
          <Th align="right">Done</Th>
          <Th align="right">Diff</Th>
          <Th align="right">Avg price</Th>
          <Th align="right">vs Fri close</Th>
          <Th align="right">vs Mon open</Th>
          <Th align="right">vs orders</Th>
          <Th align="right">Charges</Th>
          <Th>Status</Th>
        </THead>
        <tbody>
          {rebalance.rows.map((row) => (
            <FillLine key={row.symbol} row={row} />
          ))}
        </tbody>
      </Table>
      <p className="mt-2 text-xs text-muted">
        Bought {formatInr(totals.bought)}
        {totals.sold ? `, sold ${formatInr(totals.sold)}` : ''} · charges{' '}
        {formatInr(totals.real_charges, { dp: 2 })} on the notes against{' '}
        {formatInr(totals.model_charges, { dp: 2 })} at the model's rates · first-day fills against
        Friday's close {formatInr(totals.slippage_close_rs, { sign: true })}, against Monday's open{' '}
        {formatInr(totals.slippage_open_rs, { sign: true })} (+ paid more). The model assumes 15 bps
        a side.
      </p>
    </section>
  );
}

function FillLine({ row }: { row: FillRow }) {
  const later =
    row.shares_later != null
      ? `${formatNumber(row.shares_later, 0)} more later in the week at ${formatInr(row.avg_later, { dp: 2 })}`
      : '';
  const title = [row.note, later].filter(Boolean).join(' · ');
  return (
    <TRow>
      <Td className="font-medium text-foreground" title={title || undefined}>
        {row.symbol}
      </Td>
      <Td>
        {row.signal_action ? (
          <span>
            {row.signal_action}
            {row.target_weight != null ? (
              <span className="text-muted"> {formatPct(row.target_weight, 0)}</span>
            ) : null}
          </span>
        ) : (
          <span className="text-muted">not in signal</span>
        )}
      </Td>
      <Td align="right" numeric>
        {formatNumber(row.model_shares, 0)}
      </Td>
      <Td align="right" numeric>
        {formatNumber(row.plan_shares, 0)}
      </Td>
      <Td align="right" numeric title={later || undefined}>
        {formatNumber(row.shares, 0)}
      </Td>
      <Td align="right" numeric>
        {formatNumber(row.difference, 0, { sign: true })}
      </Td>
      <Td align="right" numeric>
        {formatInr(row.avg_first_day, { dp: 2 })}
      </Td>
      <Td align="right" numeric className={cn(row.vs_close_bps != null && 'text-foreground')}>
        {bps(row.vs_close_bps)}
      </Td>
      <Td align="right" numeric>
        {bps(row.vs_open_bps)}
      </Td>
      <Td align="right" numeric>
        {bps(row.vs_plan_bps)}
      </Td>
      <Td
        align="right"
        numeric
        title={
          row.model_charges != null
            ? `model's rates ${formatInr(row.model_charges, { dp: 2 })}`
            : undefined
        }
      >
        {formatInr(row.charges, { dp: 2 })}
      </Td>
      <Td className="whitespace-nowrap">
        <Badge tone={FILL_BADGE[row.status]} dot>
          {row.status}
        </Badge>
      </Td>
    </TRow>
  );
}
