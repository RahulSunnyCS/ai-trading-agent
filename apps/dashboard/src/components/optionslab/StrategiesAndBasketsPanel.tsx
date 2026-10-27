/**
 * Options Lab › Strategies and baskets (BL-102): everything that can be traded, in one place.
 *
 *  - Baskets: one line per shown rotation list (VISIBLE_LIST_KEYS; the journal still records all
 *    four), each a basket of three strategies and a Buy picked every morning, with its forward
 *    figures as the Today page reads them (`lib/strategiesBasketLine.ts`) and "Open in Today";
 *    the fixed base (and Baseline, while that list is shown) sit beneath as comparators.
 *  - Strategies: the saved leg-wise strategies (strategies/legwise/*.yaml, via
 *    GET /api/backtest/legwise/strategies) with what the evening job has saved for each one's
 *    current version, and each one's History drawer (`?strategy=<id>`; it replaced the Runs page).
 *    Editing, backtesting and saving happen in the Builder.
 *
 * A star marks a favourite; starred items are what Correlation opens on. Stars are saved on the
 * server (`useFavourites`), so they follow the owner across devices.
 */

import { GitCompareArrows, History, LayoutDashboard, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';

import { useAppRoute } from '../../hooks/useAppRoute';
import { useFavourites } from '../../hooks/useFavourites';
import { useLegwiseResults, useLegwiseStrategies } from '../../hooks/useLegwise';
import { useQueryState } from '../../hooks/useQueryState';
import { ROTATION_PAGE_LOTS, useRotationSummary } from '../../hooks/useRotation';
import { correlateHref } from '../../lib/favourites';
import { formatDay, formatInr, formatInt } from '../../lib/format';
import { type StartSpec, startToParams } from '../../lib/legwiseBuilder';
import { lastResultOf, legsSummary } from '../../lib/optionsRuns';
import { CARD_KEYS, type CardKey } from '../../lib/rotationListCards';
import { LIST_INFO, UNIVERSE_LABEL, isVisibleList } from '../../lib/rotationListNames';
import { buildPath } from '../../lib/routes';
import { type BasketLine, basketLine } from '../../lib/strategiesBasketLine';
import type { SavedStrategy } from '../../types/legwise';
import type { RotationSummary } from '../../types/rotation';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { RefreshButton } from '../ui/RefreshButton';
import { SegmentedControl, type SegmentedOption } from '../ui/SegmentedControl';
import { SkeletonRows } from '../ui/Skeleton';
import { StarToggle } from '../ui/StarToggle';
import { StateMessage } from '../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { NewStrategyDialog } from './NewStrategyDialog';
import { StrategyHistoryDrawer } from './StrategyHistoryDrawer';
import { pnlClass } from './shared';

/**
 * Moves to a sub-route with a query string. `useAppRoute().navigate` builds paths only, so
 * this pushes the entry itself, the same way (history API, never the Next router).
 */
function pushPath(pathWithQuery: string): void {
  window.history.pushState(null, '', pathWithQuery);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** The builder reads `?load=<file name>` to open that saved strategy. */
export function builderLoadHref(name: string): string {
  return `${buildPath('optionslab', 'builder')}?load=${encodeURIComponent(name)}`;
}

/** `?strategy=<id>` opens that strategy's History drawer (the old Runs link keeps working). */
const HISTORY_KEY = 'strategy';

/** The read-out the Today page asks for, so both pages share one response and one figure. */
const SUMMARY_OPTIONS = { lots: ROTATION_PAGE_LOTS } as const;

type Show = 'all' | 'starred';
const SHOW_OPTIONS: SegmentedOption<Show>[] = [
  { value: 'all', label: 'All' },
  { value: 'starred', label: 'Starred only' },
];

/** One basket card per shown list; Baseline is a comparator, never a card. */
const BASKETS = CARD_KEYS;
const WEIGHT_LABEL = ['own', 'weekday', 'dte', 'vix', 'family'] as const;
const WEIGHT_TEXT: Record<(typeof WEIGHT_LABEL)[number], string> = {
  own: 'own results',
  weekday: 'weekday',
  dte: 'days to expiry',
  vix: 'VIX',
  family: 'family',
};

function BasketFigures({ line }: { line: BasketLine }) {
  switch (line.state) {
    case 'loading':
      return <span className="text-muted">Reading the forward figures…</span>;
    case 'error':
      return (
        <span className="text-warning" title={line.reason}>
          — the forward figures could not be read
        </span>
      );
    case 'none':
      return <span className="text-muted">— no forward day scored yet</span>;
    case 'missing':
      return <span className="text-muted">— the read-out has no figures for this list</span>;
    default:
      return (
        <>
          <span>
            <span className="metric">{formatInt(line.forwardDays)}</span> forward{' '}
            {line.forwardDays === 1 ? 'day' : 'days'}
            {line.firstDay ? ` since ${formatDay(line.firstDay)}` : ''}
          </span>
          <span className={`metric ${pnlClass(line.total)}`}>
            {formatInr(line.total, { sign: true })}
          </span>
          <span>
            max drawdown <span className="metric">{formatInr(line.maxDrawdown)}</span>
          </span>
        </>
      );
  }
}

function BasketRow({
  listKey,
  summary,
  summaryError,
  starred,
  ready,
  onStar,
  onOpenToday,
  onCorrelate,
}: {
  listKey: CardKey;
  summary: RotationSummary | null;
  summaryError: string | null;
  starred: boolean;
  /** False until the stars have loaded: starring and correlating wait for them. */
  ready: boolean;
  onStar: () => void;
  onOpenToday: () => void;
  onCorrelate: () => void;
}) {
  const info = LIST_INFO[listKey];
  const line = basketLine(summary, listKey, summaryError);
  return (
    <section
      aria-label={`${info.name} basket`}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-surface px-4 py-2.5 text-xs"
    >
      <span className="inline-flex items-center gap-1.5">
        <StarToggle on={starred} label={info.name} onClick={onStar} disabled={!ready} />
        <h3 className="text-sm font-semibold text-foreground" title={info.note}>
          {info.name}
        </h3>
      </span>
      <span
        className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted"
        title="Gross, one lot per strategy, forward days only, without a portfolio stop: the Today page's figures."
      >
        <BasketFigures line={line} />
        {info.weights ? (
          <span
            title={WEIGHT_LABEL.map((k) => `${WEIGHT_TEXT[k]} ${info.weights?.[k]}`).join(' · ')}
          >
            weights{' '}
            <span className="metric">{WEIGHT_LABEL.map((k) => info.weights?.[k]).join(' · ')}</span>
          </span>
        ) : null}
      </span>
      <span className="flex-1" />
      <span className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={onOpenToday}>
          <LayoutDashboard className="h-3.5 w-3.5" />
          Open in Today
        </Button>
        <Button size="sm" variant="ghost" disabled={!ready} onClick={onCorrelate}>
          <GitCompareArrows className="h-3.5 w-3.5" />
          Correlate
        </Button>
      </span>
    </section>
  );
}

export function StrategiesAndBasketsPanel() {
  const { navigate } = useAppRoute();
  const strategies = useLegwiseStrategies();
  const results = useLegwiseResults();
  const summary = useRotationSummary(SUMMARY_OPTIONS);
  const favourites = useFavourites();
  const [show, setShow] = useState<Show>('all');
  const [starting, setStarting] = useState(false);
  const [historyId, setHistoryId] = useQueryState(HISTORY_KEY);

  const rows: SavedStrategy[] = strategies.data ?? [];
  const saved = results.data?.results ?? [];
  const set = favourites.set;
  const historyOf = historyId ? (rows.find((r) => r.strategy.id === historyId) ?? null) : null;
  const starredOnly = show === 'starred';
  // Stars decide what "Starred only" shows and what can be starred: until they have loaded
  // there is nothing to filter by and nothing to change.
  const ready = set !== null;
  const waitingForStars = starredOnly && !ready;

  // Stars are kept by strategy id: it is what Correlation's series are named, and it can differ
  // from the file name (`row.name`), which only "Open in builder" needs.
  const shownRows = starredOnly
    ? rows.filter((r) => favourites.isStrategyStarred(r.strategy.id))
    : rows;
  const shownBaskets = starredOnly ? BASKETS.filter((k) => favourites.isListStarred(k)) : BASKETS;

  const refresh = () => {
    strategies.refetch();
    results.refetch();
    summary.refetch();
    favourites.refetch();
  };

  // Start a strategy: the Builder reads the choice from the address once and opens it unsaved.
  const start = (spec: StartSpec) =>
    pushPath(`${buildPath('optionslab', 'builder')}?${startToParams(spec).toString()}`);

  const correlate = (selector: string) => {
    if (set) pushPath(correlateHref(selector, set));
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          value={show}
          options={SHOW_OPTIONS}
          onChange={setShow}
          ariaLabel="Which to show"
          size="sm"
        />
        <span className="flex-1" />
        <RefreshButton
          onClick={refresh}
          loading={strategies.loading || results.loading || summary.loading}
        />
        <Button variant="primary" size="sm" onClick={() => setStarting(true)}>
          <Plus className="h-3.5 w-3.5" />
          New strategy
        </Button>
      </div>
      <NewStrategyDialog
        open={starting}
        onOpenChange={setStarting}
        saved={rows}
        starred={new Set(set?.strategies ?? [])}
        onStart={start}
      />

      {favourites.warning ? <p className="text-xs text-warning">{favourites.warning}</p> : null}
      {summary.error ? (
        <p className="text-xs text-warning">
          {summary.data
            ? `The forward figures could not be refreshed (${summary.error}); the baskets show the last ones read.`
            : `The forward figures could not be read (${summary.error}), so the baskets show dashes.`}
        </p>
      ) : null}
      {favourites.error && !set ? (
        <p className="text-xs text-warning">
          The stars could not be loaded ({favourites.error}), so they cannot be changed right now.
        </p>
      ) : null}

      <Card>
        <CardHeader
          title="Baskets"
          description={`${BASKETS.length === 1 ? 'The rotation list picks' : 'Each rotation list picks'} three strategies and a Buy every morning at 09:16, ranked over ${UNIVERSE_LABEL}.`}
        />
        {waitingForStars ? (
          <SkeletonRows rows={2} />
        ) : shownBaskets.length === 0 ? (
          <StateMessage
            variant="empty"
            title="No basket is starred"
            description="Star a basket to find it here under Starred only."
          />
        ) : (
          <div className="space-y-2">
            {shownBaskets.map((key) => (
              <BasketRow
                key={key}
                listKey={key}
                summary={summary.data}
                summaryError={summary.error}
                starred={favourites.isListStarred(key)}
                ready={ready}
                onStar={() => favourites.toggleList(key)}
                onOpenToday={() => navigate('optionslab', 'rotation')}
                onCorrelate={() => correlate(`list:${key}`)}
              />
            ))}
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted">
          <span>{isVisibleList('REF') ? 'Comparators' : 'Comparator'}</span>
          {isVisibleList('REF') ? (
            <span className="inline-flex items-center gap-1">
              <StarToggle
                on={favourites.isListStarred('REF')}
                label={LIST_INFO.REF.name}
                disabled={!ready}
                onClick={() => favourites.toggleList('REF')}
              />
              {LIST_INFO.REF.name}: {LIST_INFO.REF.note.toLowerCase()}
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1">
            <StarToggle
              on={favourites.isListStarred('base')}
              label="Fixed base"
              disabled={!ready}
              onClick={() => favourites.toggleList('base')}
            />
            Fixed base: 2 × Widesl OTM1 09:17 + 1 × Dir ATM 09:24
          </span>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Strategies"
          description="Leg-wise strategies the evening job runs each trading day. Net is in rupees per lot."
        />

        {strategies.data === null && strategies.error !== null ? (
          <StateMessage
            variant="error"
            title="Couldn't load the saved strategies"
            description={`The options backtesting service did not answer (${strategies.error}). It is retried when you refresh.`}
          />
        ) : strategies.data === null ? (
          <SkeletonRows rows={4} />
        ) : rows.length === 0 ? (
          <StateMessage
            variant="empty"
            title="No saved strategies yet"
            description="Build one in the Builder and save it; it will be listed here and run by the evening job."
          />
        ) : waitingForStars ? (
          <SkeletonRows rows={3} />
        ) : shownRows.length === 0 ? (
          <StateMessage
            variant="empty"
            title="No strategy is starred"
            description="Star a strategy to find it here under Starred only."
          />
        ) : (
          <>
            {results.data === null && results.error !== null && (
              <p className="mb-3 text-xs text-warning">
                Saved results could not be loaded ({results.error}), so the last result column is
                empty.
              </p>
            )}
            <Table stickyFirstCol>
              <THead>
                <Th>
                  <span className="sr-only">Starred</span>
                </Th>
                <Th>Strategy</Th>
                <Th>Legs</Th>
                <Th align="right">Last result</Th>
                <Th align="right">Actions</Th>
              </THead>
              <tbody>
                {shownRows.map((row) => {
                  const legs = legsSummary(row.strategy.legs);
                  const last = lastResultOf(row, saved);
                  return (
                    <TRow key={row.name}>
                      <Td>
                        <StarToggle
                          on={favourites.isStrategyStarred(row.strategy.id)}
                          label={row.name}
                          disabled={!ready}
                          onClick={() => favourites.toggleStrategy(row.strategy.id)}
                        />
                      </Td>
                      <Td className="font-medium" title={`Version ${row.sha.slice(0, 7)}`}>
                        {row.name}
                        <span className="block text-xs font-normal text-muted">
                          {row.strategy.underlying}
                          {row.strategy.id !== row.name ? ` · id ${row.strategy.id}` : ''}
                        </span>
                      </Td>
                      <Td>
                        <span className="metric">{formatInt(legs.count)}</span>
                        <span className="text-muted"> · {legs.text}</span>
                        <span className="block text-xs text-faint">
                          {row.strategy.entry_time} to {row.strategy.exit_time}
                        </span>
                      </Td>
                      <Td align="right" className="whitespace-nowrap">
                        {last ? (
                          <>
                            <span className={`metric ${pnlClass(last.netPerLot)}`}>
                              {formatInr(last.netPerLot, { sign: true })}
                            </span>
                            <span className="text-muted">
                              {' '}
                              / lot over {formatInt(last.days)} {last.days === 1 ? 'day' : 'days'}
                            </span>
                            <span className="block text-xs text-faint">
                              {formatInt(last.upDays)} up · to {formatDay(last.lastDay)}
                            </span>
                          </>
                        ) : (
                          <span className="text-xs text-muted">
                            {results.data === null ? '—' : 'No saved days for this version'}
                          </span>
                        )}
                      </Td>
                      <Td align="right">
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => pushPath(builderLoadHref(row.name))}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                            Open in builder
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={!set || last === null}
                            title={
                              last === null
                                ? 'No saved results for this version, so there is nothing to compare'
                                : undefined
                            }
                            onClick={() => correlate(row.strategy.id)}
                          >
                            <GitCompareArrows className="h-3.5 w-3.5" />
                            Correlate
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setHistoryId(row.strategy.id)}
                          >
                            <History className="h-3.5 w-3.5" />
                            History
                          </Button>
                        </div>
                      </Td>
                    </TRow>
                  );
                })}
              </tbody>
            </Table>
          </>
        )}
      </Card>
      <StrategyHistoryDrawer
        strategy={historyOf}
        results={results.data?.results ?? null}
        resultsError={results.error}
        onClose={() => setHistoryId(null)}
      />
    </div>
  );
}
