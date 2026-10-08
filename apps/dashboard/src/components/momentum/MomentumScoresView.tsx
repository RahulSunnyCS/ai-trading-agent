'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAppRoute } from '../../hooks/useAppRoute';
import { usePolledResource } from '../../hooks/usePolledResource';
import { useScoresRoute } from '../../hooks/useScoresRoute';
import { formatDay, formatInt, formatIstTime } from '../../lib/format';
import {
  type MomentumScores,
  type StockScore,
  activeSignalFromJob,
  buyZoneFrom,
  groupBySlug,
  markKey,
  slugify,
} from '../../lib/momentumScores';
import { hydrateMomentumScoresFromStorage } from '../../store/momentumScores';
import { hydrateMomentumScoresViewsFromStorage } from '../../store/momentumScoresViews';
import type { MomentumSavedRun } from '../../types/momentum';
import { Card, CardHeader } from '../ui/Card';
import { RefreshButton } from '../ui/RefreshButton';
import { SegmentedControl } from '../ui/SegmentedControl';
import { StateMessage } from '../ui/StateMessage';
import { MomentumScoresSkeleton } from './MomentumSkeletons';
import { LiveScoresSwitch } from './scores/LiveScoresSwitch';
import { ScoresMarketStrip, ScoresMovers } from './scores/ScoresMarket';
import { SectorPage } from './scores/SectorPage';
import { SectorsOverview } from './scores/SectorsOverview';
import { StockDrawer } from './scores/StockDrawer';
import { StocksLeaderboard } from './scores/StocksLeaderboard';
import { StripGuide } from './scores/StripGuide';

/** How often live scores are re-read; the service caches them for five minutes too. */
const LIVE_SCORES_POLL_MS = 5 * 60_000;

export function MomentumScoresView() {
  // On Fridays in market hours the page can show provisional scores on live prices (BL-051).
  // `liveWindow` comes from the switch's own clock, so leaving the window turns live off by itself.
  const [wantLive, setWantLive] = useState(false);
  const [liveWindow, setLiveWindow] = useState(false);
  const live = wantLive && liveWindow;
  // Cached: the payload changes once a day, so coming back to this section shows the last copy
  // straight away while it revalidates.
  const { data, loading, error, refetch } = usePolledResource<MomentumScores>(
    live ? '/api/momentum/scores/live' : '/api/momentum/scores',
    live ? { cache: true, intervalMs: LIVE_SCORES_POLL_MS } : { cache: true },
  );
  // A failed live read keeps the closing scores on screen; say which ones they are.
  const showingLive = live && Boolean(data?.live);
  // Read-only: the most recent manual weekly run this service still remembers. It is the only
  // GET that carries a signal's rows; nothing here ever starts a run.
  const latestJob = usePolledResource<unknown>('/api/momentum/weekly/jobs/latest');
  const favorites = usePolledResource<MomentumSavedRun[]>('/api/momentum/favorite-strategies', {
    cache: true,
  });
  const { navigate } = useAppRoute();
  const {
    kind,
    group: groupSlug,
    sub: subSlug,
    stock: stockSymbol,
    go,
    closeStock,
  } = useScoresRoute();
  // The symbols in the order of the list the drawer was opened from, for its prev and next.
  const [order, setOrder] = useState<string[]>([]);

  useEffect(() => {
    hydrateMomentumScoresFromStorage();
    hydrateMomentumScoresViewsFromStorage();
  }, []);

  const here = useMemo(
    () => ({ kind, group: groupSlug, sub: subSlug }),
    [kind, groupSlug, subSlug],
  );
  // Opening a stock adds a history entry (Back closes it); stepping to another one replaces it.
  // Read through a ref so the callback keeps one identity: it goes to every row of the list, and a
  // new one each time the drawer opens would re-render them all.
  const openFrom = useRef({ here, stockSymbol });
  openFrom.current = { here, stockSymbol };
  const openStock = useCallback(
    (symbol: string) =>
      go(
        { ...openFrom.current.here, stock: symbol },
        openFrom.current.stockSymbol ? 'replace' : 'push',
      ),
    [go],
  );
  const openSector = useCallback(
    (stock: StockScore) =>
      go({ kind: 'sectors', group: slugify(stock.parent_group), sub: slugify(stock.subgroup) }),
    [go],
  );

  const activeSignal = useMemo(() => activeSignalFromJob(latestJob.data), [latestJob.data]);
  const marks = activeSignal?.marks;
  const activeFavorite = favorites.data?.find((favorite) => favorite.active);
  const zone = useMemo(() => buyZoneFrom(activeFavorite), [activeFavorite]);
  const markCounts = useMemo(() => {
    let held = 0;
    let candidate = 0;
    for (const stock of data?.stocks ?? []) {
      const mark = marks?.get(markKey(stock.symbol));
      if (mark === 'held') held += 1;
      else if (mark === 'candidate') candidate += 1;
    }
    return { held, candidate };
  }, [data, marks]);
  const signalNote = (() => {
    if (activeSignal) {
      if (activeSignal.blocked)
        return `${activeSignal.name} produced no signal in the latest weekly run, so no rows are marked Held or Candidate.`;
      if (markCounts.held + markCounts.candidate === 0)
        return `${activeSignal.name}’s latest signal names nothing listed here (it trades other instruments), so no rows are marked Held or Candidate.`;
      return `Marked from ${activeSignal.name}’s signal for the week ending ${formatDay(activeSignal.week)}: ${formatInt(markCounts.held)} held, ${formatInt(markCounts.candidate)} candidates.`;
    }
    if (latestJob.loading || favorites.loading) return null;
    return activeFavorite
      ? `Held and Candidate marks come from ${activeFavorite.name}’s latest weekly run, and no run result is available right now. They appear after the next run from This week.`
      : 'Held and Candidate marks need a headline favourite and a weekly run; neither is available right now.';
  })();

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Momentum Scores"
          description={
            data
              ? showingLive && data.live
                ? `Live prices at ${formatIstTime(new Date(data.live.as_of))} IST · provisional, the close replaces them · ${formatInt(data.stocks.length)} scored of ${formatInt(data.universe_size)} stocks`
                : `Prices as of ${data.as_of ? formatDay(data.as_of) : 'latest data'} · ${formatInt(data.stocks.length)} scored of ${formatInt(data.universe_size)} stocks`
              : 'Current stock and sector momentum'
          }
          actions={<RefreshButton onClick={refetch} loading={loading} />}
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <LiveScoresSwitch live={wantLive} onLive={setWantLive} onWindow={setLiveWindow} />
          <SegmentedControl
            ariaLabel="Score kind"
            size="sm"
            value={kind}
            options={[
              { value: 'stocks', label: 'Stocks' },
              { value: 'sectors', label: 'Sectors' },
            ]}
            onChange={(next) => go({ kind: next })}
          />
        </div>
        {data && signalNote ? <p className="mt-2 text-xs text-muted">{signalNote}</p> : null}
        {showingLive && data?.live && data.live.missing.length + data.live.suspect.length > 0 ? (
          <p className="mt-2 text-xs text-warning">
            {formatInt(data.live.priced)} stocks priced live.{' '}
            {data.live.missing.length
              ? `${formatInt(data.live.missing.length)} had no live price and keep last week's close. `
              : ''}
            {data.live.suspect.length
              ? `${formatInt(data.live.suspect.length)} moved more than 50% and keep last week's close until checked: ${data.live.suspect.join(', ')}.`
              : ''}
          </p>
        ) : null}
      </Card>

      {error ? (
        <StateMessage
          variant="error"
          title={live ? "Couldn't load live scores" : "Couldn't load momentum scores"}
          description={live && data ? `${error} Showing the last close's scores.` : error}
        />
      ) : null}
      {loading && !data && !error ? <MomentumScoresSkeleton /> : null}
      {data?.missing_symbols.length ? (
        <details className="text-xs text-warning">
          <summary>
            {formatInt(data.missing_symbols.length)} symbols have no usable price history and are
            excluded
          </summary>
          <p className="mt-1 text-muted">{data.missing_symbols.join(', ')}</p>
        </details>
      ) : null}

      {data ? (
        <>
          <StripGuide />
          {kind === 'sectors' && groupBySlug(data.rotation?.groups ?? [], groupSlug) ? null : (
            <ScoresMarketStrip
              asOf={data.as_of}
              universe={data.universe_size}
              breadth={data.breadth}
              stocks={data.stocks}
              sectors={data.sectors}
            />
          )}
          {kind === 'stocks' ? (
            <>
              <ScoresMovers stocks={data.stocks} zone={zone} marks={marks} />
              <StocksLeaderboard
                stocks={data.stocks}
                lookbacks={data.lookbacks}
                zone={zone}
                marks={marks}
                scoredCount={data.stocks.length}
                savedViews
                activeSymbol={stockSymbol}
                onOpenStock={openStock}
                onOrder={setOrder}
                onSector={openSector}
              />
            </>
          ) : !data.rotation ? (
            <MomentumScoresSkeleton />
          ) : groupSlug ? (
            (() => {
              const group = groupBySlug(data.rotation.groups, groupSlug);
              return group ? (
                <SectorPage
                  data={data}
                  group={group}
                  subSlug={subSlug}
                  zone={zone}
                  marks={marks}
                  activeSymbol={stockSymbol}
                  onBack={() => go({ kind: 'sectors' })}
                  onPickSub={(sub) => go({ kind: 'sectors', group: groupSlug, sub })}
                  onOpenStock={openStock}
                  onOrder={setOrder}
                  onSector={openSector}
                />
              ) : (
                <StateMessage
                  variant="empty"
                  title="No sector group by that name"
                  description="The link may be old. Go back to all sectors and pick one."
                />
              );
            })()
          ) : (
            <SectorsOverview
              data={data}
              zone={zone}
              marks={marks}
              activeSymbol={stockSymbol}
              onOpenGroup={(slug) => go({ kind: 'sectors', group: slug })}
              onShowAllStocks={() => go({ kind: 'stocks' })}
              onOpenStock={openStock}
              onOrder={setOrder}
              onSector={openSector}
            />
          )}
          <StockDrawer
            symbol={stockSymbol}
            stocks={data.stocks}
            order={order}
            lookbacks={data.lookbacks}
            zone={zone}
            marks={marks}
            onOpen={openStock}
            onClose={() => closeStock(here)}
            onSector={openSector}
            onBacktest={() => navigate('momentum', 'backtest', 'broad')}
          />
        </>
      ) : null}
    </div>
  );
}
