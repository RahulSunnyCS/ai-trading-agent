/**
 * Builder › YAML › Earlier runs: the YAML engine's run registry (GET /api/backtest/runs), newest
 * first, which the Runs page used to list beside the leg-wise days (it was removed 2026-10-28).
 * A row opens the stored run's headline (the registry keeps headline figures only, never the
 * per-session rows). Net is a TOTAL over the run at the lots the strategy held, as everywhere on
 * this engine; there is no side-by-side compare (the Runs page's compare went with it).
 */

import { useEffect, useState } from 'react';

import { useBacktestRun, useBacktestRuns } from '../../../hooks/useBacktestRuns';
import { formatDay, formatInr, formatInt } from '../../../lib/format';
import { headlineOfSummary } from '../../../lib/optionsRuns';
import type { RunSummary } from '../../../types/backtest';
import { Card, CardHeader } from '../../ui/Card';
import { RefreshButton } from '../../ui/RefreshButton';
import { SkeletonRows } from '../../ui/Skeleton';
import { StateMessage } from '../../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../../ui/Table';
import { pnlClass } from '../shared';
import { YamlResult } from './YamlResult';

/** How many registry rows to list; the registry returns newest first. */
const RUN_LIMIT = 25;

function periodOf(run: RunSummary): string {
  return run.date_from === run.date_to
    ? formatDay(run.date_from)
    : `${formatDay(run.date_from)} → ${formatDay(run.date_to)}`;
}

/** Mounted only once a run is picked: the hook always fetches. */
function StoredRun({ listed }: { listed: RunSummary }) {
  const { run: stored, loading, error } = useBacktestRun(listed.run_id);
  // A stored answer for another run id (the hook keeps its last data) is never shown.
  const summary = stored && stored.run_id === listed.run_id ? stored : listed;
  return (
    <div className="space-y-2">
      {loading && !stored ? <p className="text-xs text-muted">Loading the stored run…</p> : null}
      {error ? (
        <p className="text-xs text-warning">
          Could not refresh this run from the registry ({error}); showing the list's figures.
        </p>
      ) : null}
      <YamlResult
        headline={headlineOfSummary(summary)}
        result={null}
        title={`${summary.strategy_id} · v${summary.strategy_version}`}
        description={`${periodOf(summary)} · run ${summary.run_id}. The registry keeps headline figures only; per-session rows are not stored.`}
      />
    </div>
  );
}

export function YamlRunList({ latestRunId }: { latestRunId?: string | undefined }) {
  const { runs, loading, error, refresh } = useBacktestRuns(RUN_LIMIT);
  const [openId, setOpenId] = useState<string | null>(null);
  // A run made on this page is in the registry once it returns: list it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch only when a new run lands
  useEffect(() => {
    if (latestRunId) refresh();
  }, [latestRunId]);
  const open = runs.find((run) => run.run_id === openId) ?? null;
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Earlier runs"
          description={`The last ${formatInt(RUN_LIMIT)} runs of this engine, newest first. Net is the run's total. Open one for its headline figures.`}
          actions={<RefreshButton onClick={refresh} loading={loading} />}
        />
        {error ? (
          <p className="mb-3 text-xs text-warning">
            {runs.length > 0
              ? `The run registry could not be refreshed (${error}); these are the last runs read.`
              : `The run registry could not be read (${error}).`}
          </p>
        ) : null}
        {loading && runs.length === 0 ? (
          <SkeletonRows rows={3} />
        ) : runs.length === 0 ? (
          error ? null : (
            <StateMessage
              variant="empty"
              title="No runs yet"
              description="A run made above is kept in the registry and listed here."
            />
          )
        ) : (
          <Table maxHeight={360} stickyFirstCol>
            <THead>
              <Th>Strategy</Th>
              <Th>Period</Th>
              <Th align="right">Net (total)</Th>
              <Th align="right">Sessions</Th>
              <Th>Run</Th>
            </THead>
            <tbody>
              {runs.map((run) => (
                <TRow
                  key={run.run_id}
                  onClick={() => setOpenId(openId === run.run_id ? null : run.run_id)}
                  selected={openId === run.run_id}
                >
                  <Td className="font-medium">
                    {run.strategy_id}
                    <span className="ml-1.5 text-xs font-normal text-faint">
                      v{run.strategy_version}
                    </span>
                  </Td>
                  <Td className="whitespace-nowrap text-muted">{periodOf(run)}</Td>
                  <Td align="right" numeric className={pnlClass(run.net_inr)}>
                    {formatInr(run.net_inr)}
                  </Td>
                  <Td align="right" numeric>
                    {formatInt(run.n_sessions)}
                  </Td>
                  <Td className="font-mono text-xs text-faint">{run.run_id.slice(0, 8)}</Td>
                </TRow>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {open ? <StoredRun key={open.run_id} listed={open} /> : null}
    </div>
  );
}
