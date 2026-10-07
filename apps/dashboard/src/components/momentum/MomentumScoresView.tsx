'use client';

import { useEffect, useMemo } from 'react';

import { useAppRoute } from '../../hooks/useAppRoute';
import { usePolledResource } from '../../hooks/usePolledResource';
import { formatDay, formatInt } from '../../lib/format';
import {
  type MomentumScores,
  activeSignalFromJob,
  buyZoneFrom,
  markKey,
} from '../../lib/momentumScores';
import { MOMENTUM_SCORE_KINDS, type MomentumScoreKind, oneOf } from '../../lib/routes';
import { hydrateMomentumScoresFromStorage } from '../../store/momentumScores';
import type { MomentumSavedRun } from '../../types/momentum';
import { Card, CardHeader } from '../ui/Card';
import { RefreshButton } from '../ui/RefreshButton';
import { SegmentedControl } from '../ui/SegmentedControl';
import { StateMessage } from '../ui/StateMessage';
import { MomentumScoresSkeleton } from './MomentumSkeletons';
import { ScoresMarketStrip, ScoresMovers } from './scores/ScoresMarket';
import { SectorsTable } from './scores/SectorsTable';
import { StocksLeaderboard } from './scores/StocksLeaderboard';

export function MomentumScoresView() {
  // Cached: the payload changes once a day, so coming back to this section shows the last copy
  // straight away while it revalidates.
  const { data, loading, error, refetch } = usePolledResource<MomentumScores>(
    '/api/momentum/scores',
    { cache: true },
  );
  // Read-only: the most recent manual weekly run this service still remembers. It is the only
  // GET that carries a signal's rows; nothing here ever starts a run.
  const latestJob = usePolledResource<unknown>('/api/momentum/weekly/jobs/latest');
  const favorites = usePolledResource<MomentumSavedRun[]>('/api/momentum/favorite-strategies', {
    cache: true,
  });
  const { rest, navigate } = useAppRoute();
  const kind: MomentumScoreKind = oneOf(MOMENTUM_SCORE_KINDS, rest[1]) ?? 'stocks';

  useEffect(() => hydrateMomentumScoresFromStorage(), []);

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
      ? `Held and Candidate marks come from ${activeFavorite.name}’s latest weekly run, and no run result is available right now. They appear after the next run from Weekly signal.`
      : 'Held and Candidate marks need an active favourite strategy and a weekly run; neither is available right now.';
  })();

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Momentum Scores"
          description={
            data
              ? `Prices as of ${data.as_of ? formatDay(data.as_of) : 'latest data'} · ${formatInt(data.stocks.length)} scored of ${formatInt(data.universe_size)} stocks`
              : 'Current stock and sector momentum'
          }
          actions={<RefreshButton onClick={refetch} loading={loading} />}
        />
        <div className="mt-3">
          <SegmentedControl
            ariaLabel="Score kind"
            size="sm"
            value={kind}
            options={[
              { value: 'stocks', label: 'Stocks' },
              { value: 'sectors', label: 'Sectors' },
            ]}
            onChange={(next) => navigate('momentum', 'scores', next)}
          />
        </div>
        {data && signalNote ? <p className="mt-2 text-xs text-muted">{signalNote}</p> : null}
      </Card>

      {error ? (
        <StateMessage variant="error" title="Couldn't load momentum scores" description={error} />
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
          <ScoresMarketStrip
            asOf={data.as_of}
            universe={data.universe_size}
            breadth={data.breadth}
            stocks={data.stocks}
            sectors={data.sectors}
          />
          {kind === 'stocks' ? (
            <>
              <ScoresMovers stocks={data.stocks} zone={zone} marks={marks} />
              <StocksLeaderboard
                stocks={data.stocks}
                lookbacks={data.lookbacks}
                zone={zone}
                marks={marks}
                scoredCount={data.stocks.length}
              />
            </>
          ) : (
            <SectorsTable
              sectors={data.sectors}
              stocks={data.stocks}
              lookbacks={data.lookbacks}
              marks={marks}
            />
          )}
        </>
      ) : null}
    </div>
  );
}
