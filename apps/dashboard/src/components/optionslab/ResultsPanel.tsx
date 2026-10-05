/**
 * Options Lab → Results: the saved `obt daily` results per strategy, the
 * collected-data / Fyers-token status, and a button that starts the evening
 * run (collect + run every saved strategy) as a background job.
 *
 * Only results produced by the strategy file AS IT IS NOW count toward the
 * totals — a result from an earlier version of the file is shown greyed as
 * "stale" and excluded, the same rule `obt daily` applies in the terminal.
 */

import { Play, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  DEFAULT_CUTS,
  LEGWISE_API,
  useAnatomy,
  useDailyJob,
  useLegwiseData,
  useLegwiseResults,
  useLegwiseStrategies,
} from '../../hooks/useLegwise';
import { apiPost } from '../../lib/api';
import { seriesCssColor } from '../../lib/chartTheme';
import { formatPnl } from '../../lib/format';
import type { PnlDay } from '../../lib/legwiseJoin';
import { lotsOf, statsOf } from '../../lib/legwiseStats';
import type { DailyJob, DayAnatomy, SavedResult } from '../../types/legwise';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { StatCard } from '../ui/StatCard';
import { StateMessage } from '../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { DayForensics } from './DayForensics';
import { DayTypeCard } from './DayTypeCard';
import { SegmentChips } from './anatomy';
import { CumulativeLines, Field, TextInput, TradeLog, pnlClass } from './shared';

/** Cell shading by |₹ per lot| relative to the biggest cell: 3 literal buckets so
 * Tailwind's JIT sees every class name. */
function shade(value: number, max: number): string {
  if (max <= 0 || value === 0) return '';
  const r = Math.abs(value) / max;
  const tone = value > 0 ? 'positive' : 'negative';
  const step = r > 0.66 ? 3 : r > 0.33 ? 2 : 1;
  return {
    positive: ['bg-positive/10', 'bg-positive/20', 'bg-positive/30'],
    negative: ['bg-negative/10', 'bg-negative/20', 'bg-negative/30'],
  }[tone][step - 1] as string;
}

const fmtPct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(0)}%`);
const fmtPnl = (v: number | null) => (v === null ? '—' : formatPnl(v));

function RunDailyCard({ onFinished }: { onFinished: () => void }) {
  const data = useLegwiseData();
  const job = useDailyJob();
  const [day, setDay] = useState('');
  const [fetch, setFetch] = useState(true);
  const [telegram, setTelegram] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastState = useRef<DailyJob['state'] | null>(null);

  const state = job.data?.state ?? 'idle';
  const refetchData = data.refetch;
  useEffect(() => {
    if (lastState.current === 'running' && state !== 'running') {
      onFinished();
      refetchData();
    }
    lastState.current = state;
  }, [state, onFinished, refetchData]);

  async function start() {
    setError(null);
    const body: { date?: string; fetch: boolean; telegram: boolean } = { fetch, telegram };
    if (day) body.date = day;
    const result = await apiPost<DailyJob>(`${LEGWISE_API}/daily`, body);
    if (!result.ok) setError(result.error);
    job.refetch();
  }

  const token = data.data?.token;
  const niftyDays = data.data?.days.NIFTY ?? [];
  return (
    <Card>
      <CardHeader
        title="Evening run"
        description="Collect the day's 1-minute Fyers data, run every saved strategy on it, and send the summary to Telegram"
        actions={
          token ? (
            <Badge tone={token.ok ? 'positive' : 'negative'} dot>
              {token.ok ? `Fyers token OK (${token.source})` : 'Fyers login needed'}
            </Badge>
          ) : null
        }
      />
      {token && !token.ok && (
        <p className="mb-3 whitespace-pre-line text-xs text-negative">{token.message}</p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Day (blank = last closed session)">
          <TextInput type="date" value={day} onChange={setDay} />
        </Field>
        <label className="flex items-center gap-2 pb-2 text-xs text-muted">
          <input type="checkbox" checked={fetch} onChange={(e) => setFetch(e.target.checked)} />
          Collect data first
        </label>
        <label className="flex items-center gap-2 pb-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={telegram}
            onChange={(e) => setTelegram(e.target.checked)}
          />
          Send summary to Telegram
        </label>
        <Button variant="primary" disabled={state === 'running'} onClick={() => void start()}>
          <Play className="h-3.5 w-3.5" />
          {state === 'running' ? `Running ${job.data?.day ?? ''}…` : 'Run'}
        </Button>
        <span className="pb-2 text-xs text-muted">
          {niftyDays.length} NIFTY days collected
          {niftyDays.length > 0 ? ` (${niftyDays[0]} → ${niftyDays[niftyDays.length - 1]})` : ''}
        </span>
      </div>
      {error && <p className="mt-2 text-xs text-negative">{error}</p>}
      {job.data && job.data.log.length > 0 && (
        <pre className="mt-3 max-h-56 overflow-auto rounded-lg bg-surface-2/60 p-3 text-xs text-muted">
          {`${job.data.state.toUpperCase()} ${job.data.day ?? ''}\n${job.data.log.join('\n')}`}
        </pre>
      )}
    </Card>
  );
}

export function ResultsPanel() {
  const results = useLegwiseResults();
  const saved = useLegwiseStrategies();
  const anatomy = useAnatomy('NIFTY');
  const [selected, setSelected] = useState<{ strategy: string; day: string } | null>(null);

  const strategies = results.data?.strategies ?? [];
  const rows = results.data?.results ?? [];

  const byStrategy = useMemo(() => {
    const map = new Map<string, SavedResult[]>();
    for (const r of rows) {
      if (!r.current) continue;
      map.set(r.strategy_id, [...(map.get(r.strategy_id) ?? []), r]);
    }
    return map;
  }, [rows]);

  const days = useMemo(
    () => [...new Set(rows.map((r) => r.day))].sort((a, b) => b.localeCompare(a)),
    [rows],
  );
  const lotsById = useMemo(
    () => new Map((saved.data ?? []).map((s) => [s.strategy.id, lotsOf(s.strategy)])),
    [saved.data],
  );
  const statsById = useMemo(
    () =>
      new Map(
        strategies.map((s) => [s.id, statsOf(byStrategy.get(s.id) ?? [], lotsById.get(s.id) ?? 1)]),
      ),
    [strategies, byStrategy, lotsById],
  );
  const lines = useMemo(
    () => strategies.map((s) => ({ id: s.id, points: statsById.get(s.id)?.cumulative ?? [] })),
    [strategies, statsById],
  );
  const anatomyDays = useMemo(() => anatomy.data?.days ?? [], [anatomy.data]);
  const anatomyByDay = useMemo(
    () => new Map<string, DayAnatomy>((anatomy.data?.days ?? []).map((d) => [d.day, d])),
    [anatomy.data],
  );
  const maxCell = useMemo(
    () =>
      Math.max(
        0,
        ...rows
          .filter((r) => r.current)
          .map((r) => Math.abs(r.net / (lotsById.get(r.strategy_id) ?? 1))),
      ),
    [rows, lotsById],
  );
  const pnlById = useMemo(() => {
    const out = new Map<string, PnlDay[]>();
    for (const [id, list] of byStrategy) {
      const lots = lotsById.get(id) ?? 1;
      out.set(
        id,
        list.map((r) => ({ day: r.day, net: r.net / lots })),
      );
    }
    return out;
  }, [byStrategy, lotsById]);
  const segmentNames = useMemo(() => {
    const edges = ['09:15', ...DEFAULT_CUTS, '15:30'];
    return edges.slice(1).map((e, i) => `${edges[i]}–${e}`);
  }, []);
  const cell = (strategy: string, day: string) =>
    rows.find((r) => r.strategy_id === strategy && r.day === day);
  const picked = selected ? cell(selected.strategy, selected.day) : undefined;

  return (
    <div className="space-y-5">
      <RunDailyCard onFinished={results.refetch} />

      {results.error && (
        <StateMessage variant="error" title="Couldn't load results" description={results.error} />
      )}

      {!results.loading && strategies.length === 0 && (
        <StateMessage
          variant="empty"
          title="No strategies yet"
          description="Create one in the Strategy builder tab, then run the evening job."
        />
      )}

      {strategies.length > 0 && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {strategies.map((s, i) => {
              const st = statsById.get(s.id);
              if (!st) return null;
              return (
                <StatCard
                  key={s.id}
                  label={
                    <span className="flex items-center gap-1.5 normal-case tracking-normal">
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ background: seriesCssColor(i) }}
                      />
                      {s.id}
                    </span>
                  }
                  value={formatPnl(st.total)}
                  tone={st.total > 0 ? 'positive' : st.total < 0 ? 'negative' : 'muted'}
                  note={
                    <span className="block space-y-0.5">
                      <span className="block">
                        n={st.days} · {st.up} up · max DD {formatPnl(st.maxDrawdown)}
                      </span>
                      <span className={st.thin ? 'block text-faint' : 'block'}>
                        win {fmtPct(st.winRate)} · avg win {fmtPnl(st.avgWin)} · avg loss{' '}
                        {fmtPnl(st.avgLoss)}
                      </span>
                      <span className={st.thin ? 'block text-faint' : 'block'}>
                        expectancy {fmtPnl(st.expectancy)} · PF{' '}
                        {st.profitFactor === null ? '—' : st.profitFactor.toFixed(2)} · worst day{' '}
                        {fmtPnl(st.worst)} · losing streak {st.longestLosingStreak}
                      </span>
                      {st.thin && (
                        <span className="block text-faint">
                          fewer than 20 days — ratios are noise, read the days instead
                        </span>
                      )}
                    </span>
                  }
                />
              );
            })}
          </div>

          <Card>
            <CardHeader
              title="Cumulative net P&L"
              description="₹ per lot (net of each strategy's costs; a strategy's lot = its smallest leg)"
              actions={
                <Button size="sm" variant="ghost" onClick={results.refetch}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  Refresh
                </Button>
              }
            />
            <CumulativeLines lines={lines} />
          </Card>

          <Card>
            <CardHeader
              title="Day by day"
              description="₹ per lot. Click a cell to replay the day · NIFTY shape = open / mid / close segments (↑ trend up · ↓ trend down · ≈ chop · · quiet)"
            />
            <Table>
              <THead>
                <Th>Day</Th>
                <Th>NIFTY shape</Th>
                {strategies.map((s) => (
                  <Th key={s.id} align="right" title={s.id} className="max-w-[9rem] truncate">
                    {s.id}
                  </Th>
                ))}
              </THead>
              <tbody>
                {days.map((day) => (
                  <TRow key={day}>
                    <Td numeric className="whitespace-nowrap">
                      {day}
                    </Td>
                    <Td>
                      <SegmentChips anatomy={anatomyByDay.get(day)} />
                    </Td>
                    {strategies.map((s) => {
                      const r = cell(s.id, day);
                      const perLot = r ? r.net / (lotsById.get(s.id) ?? 1) : 0;
                      const active = selected?.strategy === s.id && selected.day === day;
                      return (
                        <Td key={s.id} align="right" numeric>
                          {r ? (
                            <button
                              type="button"
                              onClick={() => setSelected({ strategy: s.id, day })}
                              title={
                                r.current
                                  ? (r.stopped_by ?? '')
                                  : 'ran an older version of this strategy'
                              }
                              className={`rounded px-1.5 py-0.5 ${active ? 'ring-1 ring-border-strong' : ''} ${
                                r.current
                                  ? `${pnlClass(r.net)} ${shade(perLot, maxCell)}`
                                  : 'text-faint line-through'
                              }`}
                            >
                              {formatPnl(perLot)}
                            </button>
                          ) : (
                            <span className="text-faint">—</span>
                          )}
                        </Td>
                      );
                    })}
                  </TRow>
                ))}
              </tbody>
            </Table>
          </Card>

          <DayTypeCard
            strategies={strategies.map((s) => s.id)}
            pnl={pnlById}
            anatomy={anatomyDays}
            segmentNames={segmentNames}
          />

          {picked && (
            <DayForensics
              key={`${picked.strategy_id}:${picked.day}:${picked.strategy_sha}`}
              strategy={picked.strategy_id}
              day={picked.day}
              sha={picked.strategy_sha}
              stale={!picked.current}
              onClose={() => setSelected(null)}
              fallback={<TradeLog trades={picked.trades} />}
            />
          )}
        </>
      )}
    </div>
  );
}
