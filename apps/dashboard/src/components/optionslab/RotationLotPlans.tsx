/**
 * Rotation page → "Lot plans" (BL-135): three ways of spreading a book's lots over the day's
 * Adaptive picks, tracked forward from Mon 19 Oct 2026, for the live Adaptive (Core) or the T1
 * track. As picked is the comparator; Dir Boost and Duo come from BL-133 / BL-134 (chosen on
 * in-sample days). Net = one-lot results × lots − estimated brokerage. A waiting, late or
 * unverified day is shown and never counted; a missing figure is never a zero.
 *
 * Read through `GET /legwise/rotation/lot-plans` (`rotation/lot_plans.py` does every figure).
 */

import { useMemo, useState } from 'react';

import { useRotationLotPlans } from '../../hooks/useRotationLotPlans';
import { EMPTY, formatDay, formatInr, formatNumber } from '../../lib/format';
import {
  BOOK_LABEL,
  BOOK_OPTIONS,
  PLAN_LABEL,
  PLAN_ORDER,
  PLAN_RULE,
  STATUS_LABEL,
  STATUS_TONE,
  chartLines,
  countsText,
  dayNetText,
  emptyState,
  expiryTag,
  legsText,
  lotsText,
  orderedPlans,
  perDayVsComparator,
  readoutLines,
} from '../../lib/rotationLotPlansView';
import type { LotPlanBook, RotationLotPlansResponse } from '../../types/rotationLotPlans';
import { Badge } from '../ui/Badge';
import { Card, CardHeader } from '../ui/Card';
import { RefreshButton } from '../ui/RefreshButton';
import { SegmentedControl } from '../ui/SegmentedControl';
import { SkeletonRows } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { CumulativeLines, pnlClass } from './shared';

function money(value: number | null, sign = true): string {
  return formatInr(value, { sign });
}

function PlansTable({ d }: { d: RotationLotPlansResponse }) {
  return (
    <Table>
      <THead>
        <Th dense>Plan</Th>
        <Th dense align="right">
          Lots today
        </Th>
        <Th dense align="right">
          Days
        </Th>
        <Th dense align="right">
          Net, cumulative
        </Th>
        <Th dense align="right">
          Net per day
        </Th>
        <Th dense align="right">
          vs As picked
        </Th>
        <Th dense align="right">
          Max drawdown
        </Th>
        <Th dense align="right">
          Worst day
        </Th>
        <Th dense align="right">
          Brokerage
        </Th>
      </THead>
      <tbody>
        {orderedPlans(d).map((p) => {
          const vs = perDayVsComparator(d, p);
          return (
            <TRow key={p.plan}>
              <Td dense className="whitespace-nowrap" title={PLAN_RULE[p.plan]}>
                <span className="font-medium">{p.name}</span>
                {p.plan === d.comparator ? (
                  <span className="ml-1.5 text-[11px] text-faint">comparator</span>
                ) : null}
              </Td>
              <Td dense align="right" numeric>
                {lotsText(p.lots_today)}
              </Td>
              <Td dense align="right" numeric>
                {formatNumber(p.days, 0)}
              </Td>
              <Td dense align="right" numeric className={p.days ? pnlClass(p.net) : 'text-muted'}>
                {p.days ? money(p.net) : EMPTY}
              </Td>
              <Td
                dense
                align="right"
                numeric
                className={p.net_per_day === null ? 'text-muted' : pnlClass(p.net_per_day)}
              >
                {money(p.net_per_day)}
              </Td>
              <Td dense align="right" numeric className={vs === null ? 'text-muted' : pnlClass(vs)}>
                {money(vs)}
              </Td>
              <Td dense align="right" numeric>
                {money(p.max_drawdown, false)}
              </Td>
              <Td
                dense
                align="right"
                numeric
                title={p.worst_day ? formatDay(p.worst_day.day) : undefined}
              >
                {money(p.worst_day?.net ?? null)}
              </Td>
              <Td dense align="right" numeric className="text-muted">
                {p.days ? money(p.brokerage, false) : EMPTY}
              </Td>
            </TRow>
          );
        })}
      </tbody>
    </Table>
  );
}

function DailyRows({ d }: { d: RotationLotPlansResponse }) {
  const rows = [...d.rows].reverse(); // newest first
  return (
    <Table maxHeight={360}>
      <THead>
        <Th dense>Day</Th>
        <Th dense>Expiry</Th>
        {PLAN_ORDER.map((id) => (
          <Th key={id} dense align="right">
            {PLAN_LABEL[id]}
          </Th>
        ))}
        <Th dense>Status</Th>
      </THead>
      <tbody>
        {rows.map((row) => {
          const tag = expiryTag(row);
          return (
            <TRow key={row.day}>
              <Td dense className="whitespace-nowrap">
                {formatDay(row.day)}
              </Td>
              <Td dense className="whitespace-nowrap">
                {tag ? (
                  <Badge tone="info">{tag}</Badge>
                ) : (
                  <span className="text-faint">{EMPTY}</span>
                )}
              </Td>
              {PLAN_ORDER.map((id) => {
                const p = row.plans[id];
                return (
                  <Td
                    key={id}
                    dense
                    align="right"
                    numeric
                    className="whitespace-nowrap"
                    title={legsText(row, id)}
                  >
                    <span className="mr-2 text-[11px] text-faint">{lotsText(p.total_lots)}</span>
                    <span className={p.net === null ? 'text-muted' : pnlClass(p.net)}>
                      {dayNetText(row, id)}
                    </span>
                  </Td>
                );
              })}
              <Td dense className="max-w-[16rem] truncate" title={row.note ?? undefined}>
                <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
                {row.note ? <span className="ml-2 text-[11px] text-muted">{row.note}</span> : null}
              </Td>
            </TRow>
          );
        })}
      </tbody>
    </Table>
  );
}

export function RotationLotPlans() {
  const [book, setBook] = useState<LotPlanBook>('core');
  const res = useRotationLotPlans(book);
  const d = res.data;
  const current = d !== null && d.book === book;
  const lines = useMemo(() => (d && current ? chartLines(d) : []), [d, current]);
  const empty = d && current ? emptyState(d) : null;
  return (
    <Card>
      <CardHeader
        title="Lot plans"
        description={`${BOOK_LABEL[book]}: As picked (3 lots, one per pick) against Dir Boost and Duo, from the Adaptive picks recorded each morning since Mon 19 Oct. Net after estimated brokerage; Buy left out.`}
        actions={
          <span className="flex items-center gap-2">
            <SegmentedControl
              value={book}
              options={BOOK_OPTIONS}
              onChange={setBook}
              ariaLabel="Book"
              size="sm"
            />
            <RefreshButton onClick={res.refetch} loading={res.loading} />
          </span>
        }
      />
      {res.error ? (
        <StateMessage
          variant="error"
          title="Could not read the lot plans"
          description={res.error}
        />
      ) : d === null || !current ? (
        <SkeletonRows rows={4} />
      ) : (
        <div className="space-y-4">
          {!d.chain.intact ? (
            <StateMessage
              variant="error"
              title="The journal chain does not verify"
              description={d.chain.problems.join('; ')}
            />
          ) : null}
          <PlansTable d={d} />
          {empty ? (
            <StateMessage variant="empty" title={empty.title} description={empty.description} />
          ) : (
            <CumulativeLines lines={lines} />
          )}
          <div className="space-y-1 text-xs text-muted">
            {readoutLines(d.readout).map((line) => (
              <p key={line}>{line}</p>
            ))}
            <p className="text-[11px] text-faint">
              {countsText(d)}. Only scored days count, for all three plans at once. Dir Boost and
              Duo were chosen after looking at past days; these forward days are the test. Brokerage
              is ₹20 + GST per order, two orders a trade, once per strategy placed.
            </p>
          </div>
          {d.rows.length > 0 ? <DailyRows d={d} /> : null}
        </div>
      )}
    </Card>
  );
}
