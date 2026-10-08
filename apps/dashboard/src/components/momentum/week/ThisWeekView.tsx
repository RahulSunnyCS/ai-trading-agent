'use client';

import { useEffect, useMemo } from 'react';

import { useAppRoute } from '../../../hooks/useAppRoute';
import type { MomentumWeeklyJobState } from '../../../hooks/useMomentumWeeklyJob';
import { useNow } from '../../../hooks/useNow';
import { usePolledResource } from '../../../hooks/usePolledResource';
import { useQueryState } from '../../../hooks/useQueryState';
import { apiPost } from '../../../lib/api';
import { followedCount } from '../../../lib/momentumFavourites';
import {
  type MomentumScores,
  type StockScore,
  buyZoneFrom,
  markKey,
  slugify,
} from '../../../lib/momentumScores';
import {
  type AttentionItem,
  needsAttention,
  selectedCard,
  timeline,
} from '../../../lib/momentumWeek';
import type {
  MomentumJournal,
  MomentumLiveRules,
  MomentumSavedRun,
  MomentumStockActionReview,
  MomentumWeekView,
  MomentumWeeklyStatus,
} from '../../../types/momentum';
import { StateMessage } from '../../ui/StateMessage';
import { toast } from '../../ui/Toast';
import { StockDrawer } from '../scores/StockDrawer';
import { FavouritesCarousel } from './FavouritesCarousel';
import { FridayTimeline } from './FridayTimeline';
import { RulesStrip } from './RulesStrip';
import { EdgeNames, NeedsAttention, SincePreview, TelegramMessage } from './SidePanels';
import { SignalCard } from './SignalCard';
import { ClassifySplitDrawer, RunByHandDrawer } from './WeekDrawers';

/**
 * Momentum › This week (BL-051): the Friday timeline, what needs a person, the owner's
 * live-money rules, every favourite (headline first) and the selected one's trades, with what
 * changed since the preview, the names at the edge and the Telegram message. Replaces the
 * Weekly signal page; Your orders (Phase 3) replaces Rebalance preview below it.
 *
 * Everything that opens on top is in the URL: `?week=`, `?fav=`, `?panel=run`, `?review=SYMBOL`,
 * `?stock=SYMBOL`.
 */
export function ThisWeekView({ weekly }: { weekly: MomentumWeeklyJobState }) {
  const { navigate } = useAppRoute();
  const [week, setWeek] = useQueryState('week');
  const [favId, setFavId] = useQueryState('fav');
  const [panel, setPanel] = useQueryState('panel');
  const [review, setReview] = useQueryState('review');
  const [stockSymbol, setStockSymbol] = useQueryState('stock');
  const now = useNow(60_000);

  const view = usePolledResource<MomentumWeekView>(
    week ? `/api/momentum/week?week=${week}` : '/api/momentum/week',
    { cache: true },
  );
  const status = usePolledResource<MomentumWeeklyStatus>('/api/momentum/weekly/status', {
    cache: true,
  });
  const rules = usePolledResource<MomentumLiveRules>('/api/momentum/live-rules', { cache: true });
  const actions = usePolledResource<MomentumStockActionReview>('/api/momentum/stock-actions', {
    cache: true,
  });
  const journal = usePolledResource<MomentumJournal>('/api/momentum/journal', { cache: true });
  const favourites = usePolledResource<MomentumSavedRun[]>('/api/momentum/favorite-strategies', {
    cache: true,
  });
  const scores = usePolledResource<MomentumScores>('/api/momentum/scores', { cache: true });

  // A finished manual run may have recorded new entries and a new message.
  const finishedAt = weekly.job?.finished_at ?? null;
  const refetchView = view.refetch;
  const refetchStatus = status.refetch;
  const refetchJournal = journal.refetch;
  useEffect(() => {
    if (!finishedAt) return;
    refetchView();
    refetchStatus();
    refetchJournal();
  }, [finishedAt, refetchView, refetchStatus, refetchJournal]);

  // While a rules check runs here, poll for its result.
  const checking = rules.data?.job?.status === 'running';
  const refetchRules = rules.refetch;
  useEffect(() => {
    if (!checking) return;
    const timer = setInterval(refetchRules, 5000);
    return () => clearInterval(timer);
  }, [checking, refetchRules]);

  const steps = useMemo(
    () => (status.data && now ? timeline(status.data, now) : null),
    [status.data, now],
  );
  const attention = useMemo(
    () =>
      steps
        ? needsAttention({
            steps,
            status: status.data ?? null,
            stockActions: actions.data ?? null,
            journal: journal.data?.check ?? null,
          })
        : [],
    [steps, status.data, actions.data, journal.data],
  );
  const cards = view.data?.favourites ?? null;
  const card = cards ? selectedCard(cards, favId) : null;
  const scoreMap = useMemo(() => {
    if (!scores.data) return null;
    const map = new Map<string, StockScore>();
    for (const stock of scores.data.stocks) map.set(markKey(stock.symbol), stock);
    return map;
  }, [scores.data]);
  const headlineFavourite = favourites.data?.find((run) => run.active);
  const zone = useMemo(() => buyZoneFrom(headlineFavourite), [headlineFavourite]);
  const order = useMemo(
    () =>
      (card?.rows ?? [])
        .map((row) => scoreMap?.get(markKey(row.asset))?.symbol)
        .filter((symbol): symbol is string => Boolean(symbol)),
    [card, scoreMap],
  );

  // The weeks the journal has, newest first, plus this one: step back and forward through them.
  const weeks = view.data?.weeks ?? [];
  const shown = view.data?.week ?? null;
  const previousWeek = shown ? (weeks.find((w) => w < shown) ?? null) : null;
  const laterWeeks = shown ? weeks.filter((w) => w > shown) : [];
  const nextWeek = laterWeeks.length ? (laterWeeks[laterWeeks.length - 1] ?? null) : null;

  async function checkRules(): Promise<void> {
    const response = await apiPost('/api/momentum/live-rules/run', {});
    if (!response.ok) toast(`Could not start the check: ${response.error}`, 'error');
    rules.refetch();
  }

  function onAttention(item: AttentionItem): void {
    if (item.action?.kind === 'review') setReview(item.action.symbol);
    else if (item.action?.kind === 'run') setPanel('run');
    else if (item.action?.kind === 'journal') navigate('momentum', 'journal');
  }

  return (
    <div className="space-y-4">
      <FridayTimeline
        steps={steps}
        week={shown ?? status.data?.target_week ?? null}
        onRunByHand={() => setPanel('run')}
        onWeek={(next) => setWeek(next && next !== view.data?.target_week ? next : null)}
        previousWeek={previousWeek}
        nextWeek={nextWeek}
        running={weekly.running}
      />
      <NeedsAttention items={attention} onAction={onAttention} />
      <RulesStrip
        rules={rules.data ?? null}
        loading={rules.loading}
        onCheck={() => void checkRules()}
      />
      {view.error && !view.data ? (
        <StateMessage variant="error" title="Could not load this week" description={view.error} />
      ) : null}
      <FavouritesCarousel
        cards={cards}
        selectedId={card?.id ?? null}
        onSelect={(id) => setFavId(cards?.find((c) => c.headline)?.id === id ? null : id)}
        followed={favourites.data ? followedCount(favourites.data) : null}
      />
      {card ? (
        <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_22rem]">
          <SignalCard
            card={card}
            scores={scoreMap}
            lookbacks={scores.data?.lookbacks ?? [1, 2, 4, 8, 13, 26, 52]}
            onStock={setStockSymbol}
          />
          <div className="grid content-start gap-4 lg:grid-cols-2 2xl:grid-cols-1">
            <SincePreview card={card} />
            <EdgeNames card={card} />
            {card.headline ? (
              <TelegramMessage
                message={view.data?.message ?? null}
                onResend={() => setPanel('run')}
              />
            ) : null}
          </div>
        </div>
      ) : null}

      <RunByHandDrawer open={panel === 'run'} onClose={() => setPanel(null)} weekly={weekly} />
      <ClassifySplitDrawer
        symbol={review}
        onClose={() => setReview(null)}
        onSaved={() => {
          actions.refetch();
          toast(`${review ?? 'The move'} classified`);
        }}
      />
      {scores.data ? (
        <StockDrawer
          symbol={stockSymbol}
          stocks={scores.data.stocks}
          order={order}
          lookbacks={scores.data.lookbacks}
          zone={zone}
          marks={undefined}
          onOpen={setStockSymbol}
          onClose={() => setStockSymbol(null)}
          onSector={(stock) =>
            navigate('momentum', 'scores', 'sectors', slugify(stock.parent_group))
          }
          onBacktest={() => navigate('momentum', 'backtest', 'broad')}
        />
      ) : null}
    </div>
  );
}
