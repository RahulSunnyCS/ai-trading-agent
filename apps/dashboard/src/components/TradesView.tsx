/**
 * TradesView — the paper trades log polled from GET /api/trades.
 *
 * A toolbar filters by status, personality and IST entry day (kept in the query string:
 * ?status=open&personality=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD, so a refresh or a shared link
 * keeps them) and exports the filtered rows as CSV. The summary strip and the table cover the
 * filtered rows of the latest-100 window the API returns.
 *
 * States: loading skeleton → reassuring error banner (stale data kept) → calm empty state →
 * summary strip + the trades table.
 */

import { useMemo } from 'react';

import { TRADES_WINDOW_CAPTION, usePaperTrades } from '../hooks/usePaperTrades';
import { usePersonalities } from '../hooks/usePersonalities';
import { useQueryState } from '../hooks/useQueryState';
import { downloadCsv } from '../lib/csv';
import { formatInr, formatInt } from '../lib/format';
import {
  NO_PERSONALITY,
  TRADE_CSV_COLUMNS,
  type TradeFilters,
  filterTrades,
  hasActiveFilters,
  parseDayParam,
  parseStatusFilter,
  toTradeRows,
  tradeCsvRows,
  tradesCsvFilename,
} from '../lib/trades';
import { TradesTable } from './trades/TradesTable';
import { type PersonalityOption, TradesToolbar } from './trades/TradesToolbar';
import { Card, CardHeader } from './ui/Card';
import { SkeletonRows } from './ui/Skeleton';
import { StatCard } from './ui/StatCard';
import { StateMessage } from './ui/StateMessage';

function useTradeFilters() {
  const [status, setStatus] = useQueryState('status');
  const [personality, setPersonality] = useQueryState('personality');
  const [from, setFrom] = useQueryState('from');
  const [to, setTo] = useQueryState('to');
  const filters = useMemo<TradeFilters>(
    () => ({
      status: parseStatusFilter(status),
      personality,
      from: parseDayParam(from),
      to: parseDayParam(to),
    }),
    [status, personality, from, to],
  );
  return {
    filters,
    setStatus: (value: string) => setStatus(value === 'all' ? null : value),
    setPersonality,
    setFrom,
    setTo,
    clear: () => {
      setStatus(null);
      setPersonality(null);
      setFrom(null);
      setTo(null);
    },
  };
}

export function TradesView() {
  const { trades, loading, error } = usePaperTrades();
  // Inactive personalities too, so a paused personality's trades still show its name.
  const { personalities } = usePersonalities(true);
  const { filters, setStatus, setPersonality, setFrom, setTo, clear } = useTradeFilters();

  const filtered = useMemo(() => filterTrades(trades, filters), [trades, filters]);
  const rows = useMemo(() => toTradeRows(filtered, personalities), [filtered, personalities]);

  const personalityOptions = useMemo<PersonalityOption[]>(() => {
    const options = [...personalities]
      .sort((a, b) => (a.display_name || a.name).localeCompare(b.display_name || b.name))
      .map((p) => ({ value: p.id, label: p.display_name || p.name }));
    if (trades.some((t) => (t.personality_id ?? null) === null)) {
      options.push({ value: NO_PERSONALITY, label: 'Unassigned' });
    }
    return options;
  }, [personalities, trades]);

  const summary = useMemo(() => {
    let open = 0;
    let net = 0;
    for (const row of rows) {
      if (row.status === 'open') open += 1;
      if (row.netPnl !== null) net += row.netPnl;
    }
    return { total: rows.length, open, closed: rows.length - open, net };
  }, [rows]);

  const hasData = trades.length > 0;
  const filtering = hasActiveFilters(filters);

  return (
    <div className="space-y-5">
      {hasData ? (
        <TradesToolbar
          filters={filters}
          personalityOptions={personalityOptions}
          onStatus={setStatus}
          onPersonality={setPersonality}
          onFrom={setFrom}
          onTo={setTo}
          onClear={clear}
          canClear={filtering}
          exportCount={rows.length}
          onExport={() => downloadCsv(tradesCsvFilename(), TRADE_CSV_COLUMNS, tradeCsvRows(rows))}
        />
      ) : null}

      {hasData ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            label={filtering ? 'Matching trades' : 'Total trades'}
            value={formatInt(summary.total)}
            {...(filtering ? { note: `of ${formatInt(trades.length)} loaded` } : {})}
          />
          <StatCard
            label="Open"
            value={formatInt(summary.open)}
            tone={summary.open > 0 ? 'default' : 'muted'}
          />
          <StatCard label="Closed" value={formatInt(summary.closed)} tone="muted" />
          <StatCard
            label="Net P&L"
            value={
              <span className="whitespace-nowrap">
                {formatInr(summary.net, { dp: 2, sign: true })}
              </span>
            }
            tone={summary.net > 0 ? 'positive' : summary.net < 0 ? 'negative' : 'muted'}
            hint="Sum of net P&L over the trades shown (open trades have none yet)."
          />
        </div>
      ) : null}

      <Card flush={hasData}>
        {!hasData ? (
          <CardHeader
            title="Paper Trades"
            description="Simulated entries and exits, newest first"
          />
        ) : (
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-base font-semibold tracking-tight text-foreground">Paper Trades</h2>
            <p className="mt-0.5 text-xs text-muted">
              {TRADES_WINDOW_CAPTION}
              {filtering ? ', filtered' : ''} — the totals above cover these rows only
            </p>
          </div>
        )}

        <div className={hasData ? 'px-2 py-1' : ''}>
          {loading && !hasData && <SkeletonRows rows={4} className="pt-2" />}
          {error !== null && (
            <StateMessage
              variant="error"
              title="Couldn't load trades — retrying…"
              description={error}
              className={hasData ? 'm-3' : 'mt-4'}
            />
          )}
          {!loading && error === null && !hasData && (
            <StateMessage
              variant="empty"
              title="No paper trades yet"
              description="Trades will appear here once the engine enters a position."
            />
          )}
          {hasData && rows.length === 0 && (
            <StateMessage
              variant="empty"
              title="No trades match these filters"
              description="Change or clear the filters to see more of the loaded trades."
              className="m-3"
            />
          )}
          {rows.length > 0 && <TradesTable rows={rows} />}
        </div>
      </Card>
    </div>
  );
}
