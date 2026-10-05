/**
 * Options Lab › Strategies: the saved leg-wise strategies (strategies/legwise/*.yaml, via
 * GET /api/backtest/legwise/strategies) with what the evening job has saved for each one's
 * current version. Read-only: editing, backtesting and saving happen in the Builder.
 */

import { Pencil, Plus } from 'lucide-react';

import { useAppRoute } from '../../hooks/useAppRoute';
import { useLegwiseResults, useLegwiseStrategies } from '../../hooks/useLegwise';
import { formatDay, formatInr, formatInt } from '../../lib/format';
import { lastResultOf, legsSummary } from '../../lib/optionsRuns';
import { buildPath } from '../../lib/routes';
import type { SavedStrategy } from '../../types/legwise';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { RefreshButton } from '../ui/RefreshButton';
import { SkeletonRows } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { pnlClass } from './shared';

/** Characters of the version sha shown; the full value is in the cell's tooltip. */
const SHORT_SHA = 7;

/**
 * Moves to a sub-route with a query string. `useAppRoute().navigate` builds paths only, so
 * this pushes the entry itself, the same way (history API, never the Next router).
 */
function pushPath(pathWithQuery: string): void {
  window.history.pushState(null, '', pathWithQuery);
}

/** The builder reads `?load=<file name>` to open that saved strategy. */
export function builderLoadHref(name: string): string {
  return `${buildPath('optionslab', 'builder')}?load=${encodeURIComponent(name)}`;
}

/** Daily results reads `?strategy=<id>` to focus one strategy. */
export function resultsHref(strategyId: string): string {
  return `${buildPath('optionslab', 'results')}?strategy=${encodeURIComponent(strategyId)}`;
}

export function StrategiesPanel() {
  const { navigate } = useAppRoute();
  const strategies = useLegwiseStrategies();
  const results = useLegwiseResults();
  const rows: SavedStrategy[] = strategies.data ?? [];
  const saved = results.data?.results ?? [];

  const refresh = () => {
    strategies.refetch();
    results.refetch();
  };

  return (
    <Card>
      <CardHeader
        title="Saved strategies"
        description="Leg-wise strategies the evening job runs each trading day. Net is in rupees per lot."
        actions={
          <>
            <RefreshButton onClick={refresh} loading={strategies.loading || results.loading} />
            <Button variant="primary" size="sm" onClick={() => navigate('optionslab', 'builder')}>
              <Plus className="h-3.5 w-3.5" />
              New strategy
            </Button>
          </>
        }
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
              <Th>Name</Th>
              <Th>Underlying</Th>
              <Th>Version</Th>
              <Th>Legs</Th>
              <Th align="right">Last result</Th>
              <Th align="right">Actions</Th>
            </THead>
            <tbody>
              {rows.map((row) => {
                const legs = legsSummary(row.strategy.legs);
                const last = lastResultOf(row, saved);
                return (
                  <TRow key={row.name}>
                    <Td className="font-medium">
                      {row.name}
                      {row.strategy.id !== row.name && (
                        <span className="block text-xs font-normal text-muted">
                          id {row.strategy.id}
                        </span>
                      )}
                    </Td>
                    <Td>{row.strategy.underlying}</Td>
                    <Td numeric className="text-muted" title={row.sha}>
                      {row.sha.slice(0, SHORT_SHA)}
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
                      <div className="flex justify-end gap-2">
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
                          disabled={last === null}
                          title={last === null ? 'No saved results for this version' : undefined}
                          onClick={() => pushPath(resultsHref(row.strategy.id))}
                        >
                          View results
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
  );
}
