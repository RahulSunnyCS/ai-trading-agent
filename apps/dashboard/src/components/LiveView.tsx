/**
 * LiveView — the Live page (BL-117 Phase 3): spot, India VIX, the ATM strike and two straddles for
 * NIFTY or SENSEX, minute by minute.
 *
 *  - Today the only source is a collected day, played back from the lake (live/session.py). The
 *    page says so at the top. There is no live capture yet (BL-117 Phase 2); when it exists the
 *    same URL answers with the day so far, and this page needs no change.
 *  - Two straddles on the nearest weekly expiry: the rolling ATM (re-strikes as the index moves)
 *    and the strike that was ATM at the 09:15 open, held all day. A minute with no bar of its own
 *    (a leg that had not traded, or did not trade in that minute) is a gap in the line, never a
 *    carried value.
 *  - A response is shown only when it is the index and day the controls ask for
 *    (`isCurrentSession`): while the next one loads the page shows a skeleton, never the last
 *    one's figures.
 *  - Changes are measured since 09:15 and are never coloured as profit or loss: spot, VIX and a
 *    straddle moving is not the reader's P&L.
 *  - Index and day live in the URL query (`ix`, `d`), so a copied link shows the same session.
 *
 * It does not use the frozen server's tick socket (/ws/ticks): that needs its Redis stream,
 * which does not run here (the dashboard's client for it was removed with the Overview's Feed card).
 */

import { Info } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import { useLiveDays, useLiveSession } from '../hooks/useLiveSession';
import { useQueryState } from '../hooks/useQueryState';
import { formatDay, formatInt, formatNumber, formatPct } from '../lib/format';
import {
  type Change,
  type LiveFrame,
  type SpeedId,
  frameAt,
  isCurrentSession,
  pointsUpTo,
} from '../lib/liveSession';
import type { LiveUnderlying } from '../types/liveSession';
import { MarketSessionBadge } from './live/LiveClock';
import { LivePlayback } from './live/LivePlayback';
import { type ChartLine, LiveSessionChart } from './live/LiveSessionChart';
import { Badge } from './ui/Badge';
import { Card, CardHeader } from './ui/Card';
import { Select } from './ui/Input';
import { RefreshButton } from './ui/RefreshButton';
import { SegmentedControl } from './ui/SegmentedControl';
import { Skeleton } from './ui/Skeleton';
import { StatCard } from './ui/StatCard';
import { StateMessage } from './ui/StateMessage';
import { THead, TRow, Table, Td, Th } from './ui/Table';

const INDEXES: ReadonlyArray<{ value: LiveUnderlying; label: string }> = [
  { value: 'NIFTY', label: 'NIFTY' },
  { value: 'SENSEX', label: 'SENSEX' },
];

/** "+12.35 (+0.05%)" for a change since 09:15, or a dash when there is nothing to compare. */
function changeText(change: Change | null, unit = ''): string {
  if (change === null) return '–';
  const abs = formatNumber(change.abs, 2, { sign: true });
  const pct =
    change.pct === null ? '' : ` (${formatPct(change.pct, 2, { unit: 'percent', sign: true })})`;
  return `${abs}${unit}${pct}`;
}

/** "Fri 16 Oct 2026": a replay is picked by date, so the weekday is shown with it. */
function dayLabel(day: string): string {
  return formatDay(day, { weekday: true });
}

function value(n: number | null, dp = 2): string {
  return n === null ? '–' : formatNumber(n, dp);
}

function Swatch({ slot }: { slot: 1 | 2 | 3 | 4 }) {
  const color = { 1: 'bg-series-1', 2: 'bg-series-2', 3: 'bg-series-3', 4: 'bg-series-4' }[slot];
  return <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-sm ${color}`} />;
}

function ChartTitle({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1 mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted first:mt-0">
      {children}
    </div>
  );
}

function LegendItem({ slot, label }: { slot: 1 | 2 | 3 | 4; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Swatch slot={slot} />
      {label}
    </span>
  );
}

function Headline({
  frame,
  underlying,
  expiry,
  dte,
  fixedStrike,
}: {
  frame: LiveFrame;
  underlying: LiveUnderlying;
  expiry: string;
  dte: number;
  fixedStrike: number | null;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <StatCard
        label={`${underlying} spot`}
        value={value(frame.spot)}
        delta={changeText(frame.spotChange)}
        deltaTone="muted"
        note="Change since the 09:15 open"
      />
      <StatCard
        label="India VIX"
        value={value(frame.vix)}
        delta={changeText(frame.vixChange)}
        deltaTone="muted"
        note="Change since 09:15"
      />
      <StatCard
        label="ATM strike"
        value={frame.atm === null ? '–' : formatInt(frame.atm)}
        note={`Expiry ${formatDay(expiry)} · ${dte} weekday${dte === 1 ? '' : 's'} away`}
      />
      <StatCard
        label="Rolling ATM straddle"
        value={value(frame.rolling.straddle)}
        delta={changeText(frame.rolling.change)}
        deltaTone="muted"
        hint="Call plus put at each minute's own ATM strike, so it re-strikes as the index moves. The change is against the straddle at the 09:15 open."
        note={
          frame.straddlePctOfSpot === null
            ? 'Re-strikes with the index'
            : `${formatPct(frame.straddlePctOfSpot, 2, { unit: 'percent' })} of spot`
        }
      />
      <StatCard
        label="09:15 straddle, held"
        value={value(frame.fixed.straddle)}
        delta={changeText(frame.fixed.change)}
        deltaTone="muted"
        hint="Call plus put at the strike that was ATM at the 09:15 open, held all day: what a seller of the morning straddle holds."
        note={fixedStrike === null ? 'No strike' : `Strike ${formatInt(fixedStrike)}`}
      />
    </div>
  );
}

function LegsTable({
  frame,
  step,
}: {
  frame: LiveFrame;
  step: number;
}) {
  const rows = [
    {
      key: 'rolling',
      label: 'Rolling ATM',
      strike: frame.atm,
      ce: frame.rolling.ce,
      pe: frame.rolling.pe,
      straddle: frame.rolling.straddle,
    },
    {
      key: 'fixed',
      label: '09:15 strike, held',
      strike: frame.fixed.strike,
      ce: frame.fixed.ce,
      pe: frame.fixed.pe,
      straddle: frame.fixed.straddle,
    },
  ];
  return (
    <Table>
      <THead>
        <Th>Straddle</Th>
        <Th align="right">Strike</Th>
        <Th align="right">Call</Th>
        <Th align="right">Put</Th>
        <Th align="right">Call + put</Th>
      </THead>
      <tbody>
        {rows.map((row) => (
          <TRow key={row.key}>
            <Td className="whitespace-nowrap">{row.label}</Td>
            <Td numeric align="right">
              {row.strike === null ? '–' : formatInt(row.strike)}
            </Td>
            <Td numeric align="right">
              {value(row.ce)}
            </Td>
            <Td numeric align="right">
              {value(row.pe)}
            </Td>
            <Td numeric align="right">
              {value(row.straddle)}
            </Td>
          </TRow>
        ))}
      </tbody>
      <caption className="sr-only">Strike step {step}</caption>
    </Table>
  );
}

export function LiveView() {
  const [ixParam, setIx] = useQueryState('ix');
  const [dayParam, setDay] = useQueryState('d');
  const underlying: LiveUnderlying = ixParam === 'SENSEX' ? 'SENSEX' : 'NIFTY';

  const days = useLiveDays(underlying);
  const sessionState = useLiveSession(underlying, dayParam);
  // The hook keeps the previous response while the next one loads: show a response only when it
  // is the index and day the controls ask for, never the last one's figures under new controls.
  const session = isCurrentSession(sessionState.data, underlying, dayParam)
    ? sessionState.data
    : null;

  // null = the end of the day (the whole session drawn); a number = the minute replayed to.
  const [minute, setMinute] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<SpeedId>('10');

  const sessionKey = session ? `${session.underlying}:${session.day}` : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: a different session starts at its end, paused
  useEffect(() => {
    setMinute(null);
    setPlaying(false);
  }, [sessionKey]);

  const shown = session ? Math.min(minute ?? session.last_minute, session.last_minute) : 0;
  const whole = Math.floor(shown);
  const frame = useMemo(() => (session ? frameAt(session, whole) : null), [session, whole]);

  const spotLines = useMemo<ChartLine[]>(
    () =>
      session
        ? [
            {
              id: 'spot',
              palette: 0,
              points: pointsUpTo(session.minutes, session.spot.close, whole),
            },
          ]
        : [],
    [session, whole],
  );
  const straddleLines = useMemo<ChartLine[]>(
    () =>
      session
        ? [
            {
              id: 'rolling',
              palette: 1,
              points: pointsUpTo(session.minutes, session.rolling.straddle, whole),
            },
            {
              id: 'fixed',
              palette: 2,
              points: pointsUpTo(session.minutes, session.fixed.straddle, whole),
            },
          ]
        : [],
    [session, whole],
  );
  const vixLines = useMemo<ChartLine[]>(
    () =>
      session?.vix
        ? [{ id: 'vix', palette: 3, points: pointsUpTo(session.minutes, session.vix, whole) }]
        : [],
    [session, whole],
  );

  const onMinute = useCallback((next: number) => setMinute(next), []);
  const dayOptions = useMemo(() => {
    // the same rule for the day list: another index's days are not offered under this one
    const list = days.data?.underlying === underlying ? days.data.days : [];
    const chosen = dayParam || session?.day;
    return chosen && !list.includes(chosen) ? [chosen, ...list] : list;
  }, [days.data, underlying, dayParam, session]);

  const replay = session ? !session.live.available : true;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <MarketSessionBadge />
        <SegmentedControl
          ariaLabel="Index"
          value={underlying}
          options={INDEXES}
          onChange={(next) => {
            setIx(next === 'NIFTY' ? null : next);
            setDay(null);
          }}
        />
        {replay ? (
          <>
            <Badge tone="info">Replay</Badge>
            <Select
              aria-label="Day to replay"
              value={dayParam || session?.day || ''}
              onChange={(event) => setDay(event.target.value)}
              disabled={dayOptions.length === 0}
              className="w-auto"
            >
              {dayOptions.map((d) => (
                <option key={d} value={d}>
                  {dayLabel(d)}
                </option>
              ))}
            </Select>
          </>
        ) : (
          <Badge tone="positive">Live</Badge>
        )}
        <div className="ml-auto">
          <RefreshButton onClick={sessionState.refetch} loading={sessionState.loading} />
        </div>
      </div>

      {session && replay ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-info/30 bg-info/10 px-4 py-3 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden="true" />
          <p className="text-foreground">
            <span className="font-medium">Replay of {dayLabel(session.day)}.</span>{' '}
            <span className="text-muted">{session.live.reason}</span>
          </p>
        </div>
      ) : null}

      {sessionState.error && !session ? (
        <StateMessage
          variant="error"
          title="The session could not be loaded"
          description={`${sessionState.error}. The research API (obt-api) must be running; the dashboard reads it through /api/backtest.`}
        />
      ) : null}

      {!session && !sessionState.error ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      ) : null}

      {session && frame ? (
        <>
          {sessionState.error ? (
            <StateMessage
              variant="error"
              title="Showing the last loaded session"
              description={sessionState.error}
            />
          ) : null}

          <Headline
            frame={frame}
            underlying={session.underlying}
            expiry={session.expiry}
            dte={session.dte_weekdays}
            fixedStrike={session.fixed.strike}
          />

          <Card>
            <CardHeader
              title="Spot and straddles"
              description={`${session.underlying} on ${dayLabel(session.day)}, one minute a point, 09:15 to 15:30 IST.`}
            />
            {replay ? (
              <div className="mb-4">
                <LivePlayback
                  minute={shown}
                  last={session.last_minute}
                  timeAt={frame.time}
                  playing={playing}
                  speed={speed}
                  onMinute={onMinute}
                  onPlaying={setPlaying}
                  onSpeed={setSpeed}
                />
              </div>
            ) : null}

            <ChartTitle>
              <LegendItem slot={1} label={`${session.underlying} spot`} />
            </ChartTitle>
            <LiveSessionChart
              lines={spotLines}
              height={200}
              minutes={session.minutes}
              timeAxis={false}
              ariaLabel={`${session.underlying} spot minute by minute on ${dayLabel(session.day)}`}
              className="rounded-lg border border-border bg-surface-2/40 p-1"
            />

            <ChartTitle>
              <LegendItem slot={2} label="Rolling ATM straddle" />
              <LegendItem slot={3} label="09:15 straddle, held" />
            </ChartTitle>
            <LiveSessionChart
              lines={straddleLines}
              height={220}
              minutes={session.minutes}
              timeAxis={!session.vix}
              ariaLabel={`Call plus put premium minute by minute on ${dayLabel(session.day)}: the rolling ATM straddle and the straddle at the 09:15 strike`}
              className="rounded-lg border border-border bg-surface-2/40 p-1"
            />

            {session.vix ? (
              <>
                <ChartTitle>
                  <LegendItem slot={4} label="India VIX" />
                </ChartTitle>
                <LiveSessionChart
                  lines={vixLines}
                  height={130}
                  minutes={session.minutes}
                  ariaLabel={`India VIX minute by minute on ${dayLabel(session.day)}`}
                  className="rounded-lg border border-border bg-surface-2/40 p-1"
                />
              </>
            ) : null}
          </Card>

          <Card>
            <CardHeader
              title="The legs at this minute"
              description={`Nearest weekly expiry ${formatDay(session.expiry)}, strikes every ${formatInt(session.strike_step)}. A dash is a leg that had not traded or a strike that was not collected.`}
            />
            <LegsTable frame={frame} step={session.strike_step} />
            <p className="mt-3 text-xs text-faint">
              Range so far {value(frame.range.soFar)} points
              {frame.range.versusMedian === null
                ? ''
                : `, ${formatNumber(frame.range.versusMedian, 2)}× the median full session of the last ${session.range.median_sessions}`}
              . Descriptive only: nothing here is a signal.
            </p>
          </Card>
        </>
      ) : null}
    </div>
  );
}
