/**
 * Commodity Lab › Forward test (BL-219): the GOLDM Dir expiry-week paper test. The rule is frozen;
 * every session is scored the night it happens into a hash-chained journal. Shows the registered
 * pass rule against the running totals, the coming window, the cumulative net at three slippage
 * levels, the journal, and the 18:00 bid-ask snapshots beside the 1% a fill the backtest assumed.
 * No order is ever sent from here.
 */

import { useMemo } from 'react';

import { useCommodityForward } from '../../hooks/useCommodity';
import {
  cumulativeLines,
  medianHalfSpreadPct,
  passRuleLines,
  tradeText,
} from '../../lib/commodityView';
import { EMPTY, formatDay, formatDayShort, formatInr, formatNumber } from '../../lib/format';
import type { CommodityForward as Forward, SpreadSnapshot } from '../../types/commodity';
import { CumulativeLines, pnlClass } from '../optionslab/shared';
import { Badge } from '../ui/Badge';
import { Card, CardHeader } from '../ui/Card';
import { RefreshButton } from '../ui/RefreshButton';
import { SkeletonRows } from '../ui/Skeleton';
import { StatCard } from '../ui/StatCard';
import { StateMessage } from '../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { WindowStrip } from './WindowStrip';

function Headline({ d }: { d: Forward }) {
  const s = d.summary;
  const none = s.sessions === 0;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      <StatCard
        label="Net, 1% slippage"
        value={none ? EMPTY : formatInr(s.net, { sign: true })}
        tone={s.net > 0 ? 'positive' : s.net < 0 ? 'negative' : 'muted'}
        note="The registered basis"
      />
      <StatCard
        label="Net, 0.5%"
        value={none ? EMPTY : formatInr(s['net_0.5pct'], { sign: true })}
        tone="muted"
      />
      <StatCard
        label="Net, no slippage"
        value={none ? EMPTY : formatInr(s.net_0pct, { sign: true })}
        tone="muted"
      />
      <StatCard
        label="Profit factor"
        value={s.profit_factor === null ? EMPTY : formatNumber(s.profit_factor, 2)}
        note={s.profit_factor === null ? 'Needs a winning and a losing session' : undefined}
      />
      <StatCard
        label="Expiries up"
        value={`${s.expiries_up} of ${s.expiries}`}
        note={`Of ${d.pass_rule.expiries} to run`}
      />
    </div>
  );
}

function Journal({ d }: { d: Forward }) {
  if (d.entries.length === 0) {
    return (
      <StateMessage
        variant="empty"
        title="No session scored yet"
        description={`The first window is the ${formatDay(d.start_expiry)} expiry. A session is scored at 01:30 the next morning, once the collector has its bars.`}
      />
    );
  }
  return (
    <Table>
      <THead>
        <Th dense>Session</Th>
        <Th dense align="right">
          To expiry
        </Th>
        <Th dense align="right">
          Gross
        </Th>
        <Th dense align="right">
          Charges
        </Th>
        <Th dense align="right">
          Net (1%)
        </Th>
        <Th dense>What it did</Th>
      </THead>
      <tbody>
        {[...d.entries].reverse().map((e) => (
          <TRow key={e.day}>
            <Td dense className="whitespace-nowrap">
              {formatDay(e.day, { weekday: true })}
              <span className="ml-2 text-[11px] text-faint">{e.season}</span>
            </Td>
            <Td dense align="right" numeric>
              {e.k === 0 ? 'expiry day' : `−${e.k}`}
            </Td>
            <Td dense align="right" numeric className={pnlClass(e.gross)}>
              {formatInr(e.gross, { sign: true })}
            </Td>
            <Td dense align="right" numeric className="text-muted">
              {formatInr(e.charges)}
            </Td>
            <Td dense align="right" numeric className={pnlClass(e.net)}>
              {formatInr(e.net, { sign: true })}
            </Td>
            <Td dense className="max-w-[28rem] text-xs text-muted">
              {e.trades.length === 0 ? 'No entry' : e.trades.map(tradeText).join(' · ')}
              {e.notes.length > 0 ? (
                <span className="ml-2 text-warning">{e.notes.join('; ')}</span>
              ) : null}
            </Td>
          </TRow>
        ))}
      </tbody>
    </Table>
  );
}

function Spreads({ spreads }: { spreads: SpreadSnapshot[] }) {
  const half = medianHalfSpreadPct(spreads);
  return (
    <Card>
      <CardHeader
        title="Real bid-ask spread"
        description="At 18:00 on each window weekday the entry contracts’ bid and ask are read (read-only) and kept. The backtest charged 1% a fill."
      />
      {spreads.length === 0 ? (
        <StateMessage
          variant="empty"
          title="No snapshot yet"
          description="The first is read at 18:00 on the first window weekday."
        />
      ) : (
        <div className="space-y-3">
          <StatCard
            label="Median half-spread"
            value={half === null ? EMPTY : `${formatNumber(half, 2)}%`}
            note="Of the ITM1 call and put’s mid price, across snapshots. Compare with the 1% assumed."
            className="max-w-xs"
          />
          <Table>
            <THead>
              <Th dense>Day</Th>
              <Th dense align="right">
                ITM1 CE spread
              </Th>
              <Th dense align="right">
                ITM1 PE spread
              </Th>
              <Th dense align="right">
                ATM CE spread
              </Th>
              <Th dense align="right">
                ATM PE spread
              </Th>
            </THead>
            <tbody>
              {[...spreads].reverse().map((s) => (
                <TRow key={s.day}>
                  <Td dense>{formatDay(s.day)}</Td>
                  {(['ITM1_CE', 'ITM1_PE', 'ATM_CE', 'ATM_PE'] as const).map((k) => {
                    const v = s.contracts?.[k]?.spread_pct_of_mid;
                    return (
                      <Td key={k} dense align="right" numeric>
                        {typeof v === 'number' ? `${formatNumber(v, 2)}%` : EMPTY}
                      </Td>
                    );
                  })}
                </TRow>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </Card>
  );
}

export function CommodityForward() {
  const res = useCommodityForward();
  const d = res.data;
  const lines = useMemo(() => (d ? cumulativeLines(d.entries) : []), [d]);
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="The registered rule"
          description="Frozen before the first session: nothing in the forward period feeds back into it."
          actions={<RefreshButton onClick={res.refetch} loading={res.loading} />}
        />
        {res.error ? (
          <StateMessage
            variant="error"
            title="Could not read the forward test"
            description={res.error}
          />
        ) : d === null ? (
          <SkeletonRows rows={4} />
        ) : (
          <div className="space-y-4">
            {!d.chain.ok ? (
              <StateMessage
                variant="error"
                title="The journal chain does not verify"
                description={d.chain.problems.join('; ')}
              />
            ) : null}
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone="accent">GOLDM Dir</Badge>
              <span className="text-muted">
                Sell the in-the-money call and put at 18:00 · 21% stop on each leg · re-enter once
                at cost · hold to 15 minutes before the close (
                {Object.entries(d.rule.exits)
                  .map(([season, time]) => `${time} ${season}`)
                  .join(', ')}
                ) · 1 lot · expiry week only
              </span>
            </div>
            <Headline d={d} />
            <ul className="space-y-1 text-sm text-muted">
              {passRuleLines(d).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {d ? (
        <>
          <Card>
            <CardHeader
              title={d.window ? `Window for the ${formatDay(d.window.expiry)} expiry` : 'Window'}
              description={`The last ${d.rule.window_sessions} sessions up to and including expiry day. A session with no data is left waiting and alerted, never skipped.`}
            />
            {d.window ? (
              <WindowStrip window={d.window} />
            ) : (
              <StateMessage
                variant="empty"
                title="No window open"
                description="No later expiry is in the calendar."
              />
            )}
          </Card>

          <Card>
            <CardHeader
              title="Running net"
              description="One lot, after charges. The three lines differ only in the slippage charged on every fill."
            />
            {d.entries.length === 0 ? (
              <StateMessage variant="empty" title="Nothing to draw yet" />
            ) : d.entries.length === 1 ? (
              <p className="text-sm text-muted">
                One session so far ({formatDayShort(d.entries[0]?.day)}): a line needs two.
              </p>
            ) : (
              <CumulativeLines lines={lines} />
            )}
          </Card>

          <Card flush>
            <div className="p-5 pb-0">
              <CardHeader
                title="Journal"
                description="Each session as recorded, newest first. Entries are hash-chained and never edited."
              />
            </div>
            <div className="px-5 pb-5">
              <Journal d={d} />
            </div>
          </Card>

          <Spreads spreads={d.spreads} />
        </>
      ) : null}
    </div>
  );
}
