/**
 * Rotation page → "Live vs paper" (BL-141 Phase 3): what AlgoTest and Quantiply actually made on
 * each captured day, beside the paper result for the same strategies at one lot. Both sides are
 * per lot and after the same estimated costs; slippage = live − paper, so + means live did better.
 * A day that was not captured, a copy that did not trade, one entered off its slot or with legs
 * still open is flagged and kept out of the gap; the owner's own (discretionary) trades are summed
 * apart and never compared. A missing figure is a dash, never a zero.
 *
 * Read through `GET /legwise/rotation/live` (`rotation/live_compare.py` does every figure).
 */

import { useMemo } from 'react';

import { useRotationLive } from '../../hooks/useRotationLive';
import { EMPTY, formatDay, formatInr, formatNumber } from '../../lib/format';
import {
  chartLines,
  dayBadges,
  emptyState,
  groupKey,
  groupLabel,
  newestFirst,
  shapeLabel,
  shapeThin,
  slippageText,
} from '../../lib/rotationLiveView';
import type { LiveDay, RotationLiveResponse } from '../../types/rotationLive';
import { Badge } from '../ui/Badge';
import { Card, CardHeader } from '../ui/Card';
import { RefreshButton } from '../ui/RefreshButton';
import { SkeletonRows } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { CumulativeLines, pnlClass } from './shared';

function Totals({ d }: { d: RotationLiveResponse }) {
  return (
    <Table>
      <THead>
        <Th dense>List</Th>
        <Th dense align="right">
          Days
        </Th>
        <Th dense align="right">
          Live, a lot
        </Th>
        <Th dense align="right">
          Paper, a lot
        </Th>
        <Th dense align="right">
          Slippage
        </Th>
      </THead>
      <tbody>
        {d.running.map((g) => (
          <TRow key={groupKey(g)}>
            <Td dense className="whitespace-nowrap font-medium">
              {groupLabel(g)}
            </Td>
            <Td dense align="right" numeric>
              {formatNumber(g.days, 0)}
            </Td>
            <Td dense align="right" numeric className={pnlClass(g.live)}>
              {formatInr(g.live, { sign: true })}
            </Td>
            <Td dense align="right" numeric className={pnlClass(g.paper)}>
              {formatInr(g.paper, { sign: true })}
            </Td>
            <Td dense align="right" numeric className={pnlClass(g.slippage)}>
              {slippageText(g.slippage)}
            </Td>
          </TRow>
        ))}
        <TRow>
          <Td
            dense
            className="whitespace-nowrap font-medium"
            title="Your own trades, never compared"
          >
            Discretionary
          </Td>
          <Td dense align="right" numeric>
            {EMPTY}
          </Td>
          <Td dense align="right" numeric className={pnlClass(d.discretionary.total)}>
            {formatInr(d.discretionary.total, { sign: true })}
          </Td>
          <Td dense align="right" numeric>
            {EMPTY}
          </Td>
          <Td dense align="right" numeric>
            {EMPTY}
          </Td>
        </TRow>
      </tbody>
    </Table>
  );
}

function DailyRows({ days }: { days: LiveDay[] }) {
  return (
    <Table maxHeight={360}>
      <THead>
        <Th dense>Day</Th>
        <Th dense>List</Th>
        <Th dense align="right">
          Live, a lot
        </Th>
        <Th dense align="right">
          Paper, a lot
        </Th>
        <Th dense align="right">
          Slippage
        </Th>
        <Th dense>Flags</Th>
      </THead>
      <tbody>
        {newestFirst(days).flatMap((day) => {
          const badges = dayBadges(day);
          const flags = (
            <Td dense className="space-x-1">
              {badges.map((b) => (
                <Badge key={b.text} tone={b.tone}>
                  {b.text}
                </Badge>
              ))}
              {day.discretionary_count ? (
                <span className="text-[11px] text-muted">
                  discretionary {formatInr(day.discretionary_total, { sign: true })}
                </span>
              ) : null}
            </Td>
          );
          if (day.groups.length === 0) {
            return [
              <TRow key={day.day}>
                <Td dense className="whitespace-nowrap">
                  {formatDay(day.day)}
                </Td>
                <Td dense className="text-muted">
                  {EMPTY}
                </Td>
                <Td dense align="right" numeric>
                  {EMPTY}
                </Td>
                <Td dense align="right" numeric>
                  {EMPTY}
                </Td>
                <Td dense align="right" numeric>
                  {EMPTY}
                </Td>
                {flags}
              </TRow>,
            ];
          }
          return day.groups.map((g, i) => (
            <TRow key={`${day.day}.${groupKey(g)}`}>
              <Td dense className="whitespace-nowrap">
                {i === 0 ? formatDay(day.day) : ''}
              </Td>
              <Td dense className="whitespace-nowrap">
                {groupLabel(g)}
              </Td>
              <Td dense align="right" numeric className={pnlClass(g.live)}>
                {formatInr(g.live, { sign: true })}
              </Td>
              <Td dense align="right" numeric className={pnlClass(g.paper)}>
                {formatInr(g.paper, { sign: true })}
              </Td>
              <Td dense align="right" numeric className={pnlClass(g.slippage)}>
                {slippageText(g.slippage, g.slippage_pct)}
              </Td>
              {i === 0 ? flags : <Td dense>{null}</Td>}
            </TRow>
          ));
        })}
      </tbody>
    </Table>
  );
}

function Shapes({ d }: { d: RotationLiveResponse }) {
  return (
    <Table>
      <THead>
        <Th dense>Platform · side · entry time</Th>
        <Th dense align="right">
          Variant-days
        </Th>
        <Th dense align="right">
          Slippage, total
        </Th>
        <Th dense align="right">
          Per variant-day
        </Th>
      </THead>
      <tbody>
        {d.shapes.map((s) => (
          <TRow key={`${s.platform}.${s.position}.${s.band}`}>
            <Td dense className="whitespace-nowrap">
              {shapeLabel(s)}
              {shapeThin(s) ? <span className="ml-1.5 text-[11px] text-faint">thin</span> : null}
            </Td>
            <Td dense align="right" numeric>
              {formatNumber(s.variant_days, 0)}
            </Td>
            <Td dense align="right" numeric className={pnlClass(s.slippage)}>
              {slippageText(s.slippage, s.slippage_pct)}
            </Td>
            <Td dense align="right" numeric className={pnlClass(s.mean_slippage)}>
              {slippageText(s.mean_slippage)}
            </Td>
          </TRow>
        ))}
      </tbody>
    </Table>
  );
}

export function RotationLiveVsPaper() {
  const res = useRotationLive();
  const d = res.data;
  const lines = useMemo(() => (d ? chartLines(d) : []), [d]);
  const empty = d ? emptyState(d) : null;
  return (
    <Card>
      <CardHeader
        title="Live vs paper"
        description="What the platforms made on each captured day against the backtest for the same strategies, a lot at a time, after the same estimated costs. + means live did better. Contract notes are the ground truth."
        actions={<RefreshButton onClick={res.refetch} loading={res.loading} />}
      />
      {res.error ? (
        <StateMessage
          variant="error"
          title="Could not read the live results"
          description={res.error}
        />
      ) : d === null ? (
        <SkeletonRows rows={4} />
      ) : (
        <div className="space-y-4">
          {empty ? (
            <StateMessage variant="empty" title={empty.title} description={empty.description} />
          ) : (
            <>
              <Totals d={d} />
              <CumulativeLines lines={lines} />
            </>
          )}
          {d.days.length > 0 ? (
            <details className="group">
              <summary className="cursor-pointer text-xs font-medium text-muted hover:text-foreground">
                Day by day, every platform and list ({d.days.length}{' '}
                {d.days.length === 1 ? 'day' : 'days'}). Adaptive Classic's live result per day is
                also in the Daily log.
              </summary>
              <div className="mt-2">
                <DailyRows days={d.days} />
              </div>
            </details>
          ) : null}
          {d.shapes.length > 0 ? (
            <div className="space-y-1">
              <h3 className="text-xs font-medium text-muted">Slippage by shape</h3>
              <Shapes d={d} />
              <p className="text-[11px] text-faint">
                The percentage is of the premium at the first entry, where fills are known;
                Quantiply does not show them, so it has none. A shape with few variant-days is thin.
              </p>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}
