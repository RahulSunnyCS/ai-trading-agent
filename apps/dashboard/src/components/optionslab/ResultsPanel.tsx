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
  LEGWISE_API,
  useDailyJob,
  useLegwiseData,
  useLegwiseResults,
} from '../../hooks/useLegwise.js';
import { apiPost } from '../../lib/api.js';
import { formatPnl } from '../../lib/format.js';
import type { DailyJob, SavedResult } from '../../types/legwise.js';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { StatCard } from '../ui/StatCard';
import { StateMessage } from '../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import {
  CumulativeLines,
  Field,
  SERIES_COLORS,
  TextInput,
  TradeLog,
  pnlClass,
  statsOf,
} from './shared';

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
  const lines = useMemo(
    () =>
      strategies.map((s) => ({ id: s.id, points: statsOf(byStrategy.get(s.id) ?? []).cumulative })),
    [strategies, byStrategy],
  );
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
              const st = statsOf(byStrategy.get(s.id) ?? []);
              return (
                <StatCard
                  key={s.id}
                  label={
                    <span className="flex items-center gap-1.5 normal-case tracking-normal">
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }}
                      />
                      {s.id}
                    </span>
                  }
                  value={formatPnl(st.total)}
                  tone={st.total > 0 ? 'positive' : st.total < 0 ? 'negative' : 'muted'}
                  note={`${st.days} days · ${st.up} up · max DD ${formatPnl(st.maxDrawdown)}`}
                />
              );
            })}
          </div>

          <Card>
            <CardHeader
              title="Cumulative net P&L"
              description="1 lot per leg as configured, costs as set in each strategy"
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
            <CardHeader title="Day by day" description="Click a cell to see that day's trades" />
            <Table>
              <THead>
                <Th>Day</Th>
                {strategies.map((s) => (
                  <Th key={s.id} align="right">
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
                    {strategies.map((s) => {
                      const r = cell(s.id, day);
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
                              className={`rounded px-1.5 py-0.5 ${active ? 'bg-surface-2 ring-1 ring-border-strong' : ''} ${
                                r.current ? pnlClass(r.net) : 'text-faint line-through'
                              }`}
                            >
                              {formatPnl(r.net)}
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

          {picked && (
            <Card>
              <CardHeader
                title={`${picked.strategy_id} · ${picked.day}`}
                description={[
                  `net ${formatPnl(picked.net)}`,
                  `worst MTM ${formatPnl(picked.worst_mtm)}`,
                  picked.stopped_by,
                  picked.current ? null : 'stale: older version of the strategy',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
              <TradeLog trades={picked.trades} />
              {picked.notes.map((n) => (
                <p key={n} className="mt-2 text-xs text-muted">
                  note: {n}
                </p>
              ))}
            </Card>
          )}
        </>
      )}
    </div>
  );
}
