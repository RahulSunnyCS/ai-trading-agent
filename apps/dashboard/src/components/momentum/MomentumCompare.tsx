'use client';

import { useState } from 'react';

import { cn } from '../../lib/cn';
import { formatIstDate } from '../../lib/format';
import {
  COMPARE_METRICS,
  MAX_COMPARE,
  bestRunIndex,
  differingSettings,
  runBenchmark,
  runPeriod,
  toggleSelection,
} from '../../lib/momentumCompare';
import type { MomentumSavedRun } from '../../types/momentum';
import { Badge } from '../ui/Badge';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { ResultSection } from './ResultSection';

const LIMIT_MESSAGE = `Compare takes up to ${MAX_COMPARE} runs. Untick one to add another.`;

function runName(run: MomentumSavedRun): string {
  return run.name || `Run ${run.n}`;
}

/**
 * The one comparison of saved runs, used by Momentum › Saved runs and by a result's Compare
 * tab: up to four runs side by side (period and benchmark first, then the metrics with the
 * best value per row marked) and every setting on which they differ.
 *
 * Selection is either the caller's (`selectedIds` + `onSelectedIdsChange`, e.g. checkboxes in
 * the Saved runs table) or, when those are absent, the component's own: it starts with the
 * first four runs and offers a tick list.
 */
export function MomentumCompare({
  runs,
  selectedIds,
  onSelectedIdsChange,
  picker,
}: {
  runs: MomentumSavedRun[];
  /** Ids of the runs to compare, in column order. Omit to let the component keep its own. */
  selectedIds?: string[];
  onSelectedIdsChange?: (ids: string[]) => void;
  /** Show the tick list of runs. Defaults to on when the component owns the selection. */
  picker?: boolean;
}) {
  const controlled = selectedIds !== undefined;
  const [ownIds, setOwnIds] = useState<string[] | null>(null);
  const [refused, setRefused] = useState(false);
  const showPicker = picker ?? !controlled;

  const ids = selectedIds ?? ownIds ?? runs.slice(0, MAX_COMPARE).map((run) => run.id);
  const chosen = ids
    .map((id) => runs.find((run) => run.id === id))
    .filter((run): run is MomentumSavedRun => run !== undefined)
    .slice(0, MAX_COMPARE);

  function toggle(id: string): void {
    const next = toggleSelection(
      chosen.map((run) => run.id),
      id,
    );
    setRefused(next.refused);
    if (next.refused) return;
    if (controlled) onSelectedIdsChange?.(next.selected);
    else setOwnIds(next.selected);
  }

  if (runs.length === 0) {
    return (
      <ResultSection
        title="Compare runs"
        description="Save a few backtests, then compare them here"
      >
        <p className="text-sm text-muted">No saved runs yet for this strategy.</p>
      </ResultSection>
    );
  }

  const differences = differingSettings(chosen.map((run) => run.config));

  return (
    <ResultSection
      title="Compare runs"
      description={`Up to ${MAX_COMPARE} saved runs side by side. The best value in each row is highlighted.`}
      actions={
        <span className="text-xs text-muted">
          {chosen.length} of {MAX_COMPARE} selected
        </span>
      }
    >
      {showPicker && runs.length > 1 ? (
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1.5">
          <legend className="sr-only">Runs to compare</legend>
          {runs.map((run) => (
            <label key={run.id} className="flex items-center gap-1.5 text-xs text-muted">
              <input
                type="checkbox"
                className="accent-primary"
                checked={chosen.some((item) => item.id === run.id)}
                onChange={() => toggle(run.id)}
              />
              <span className="text-foreground">{runName(run)}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {refused ? <output className="block text-xs text-warning">{LIMIT_MESSAGE}</output> : null}

      {chosen.length === 0 ? (
        <p className="text-sm text-muted">
          {showPicker
            ? 'Tick two to four runs above to compare them.'
            : 'Tick two to four runs in the table to compare them.'}
        </p>
      ) : (
        <>
          <Table stickyFirstCol>
            <THead>
              <Th>Metric</Th>
              {chosen.map((run) => (
                <Th key={run.id} align="right" className="normal-case tracking-normal">
                  <span className="inline-flex items-center justify-end gap-1.5 text-foreground">
                    {runName(run)}
                    {run.active ? <Badge tone="primary">Headline</Badge> : null}
                  </span>
                </Th>
              ))}
            </THead>
            <tbody>
              <TRow>
                <Td className="text-xs text-muted">Period</Td>
                {chosen.map((run) => (
                  <Td key={run.id} align="right" className="whitespace-nowrap text-xs">
                    {runPeriod(run.config)}
                  </Td>
                ))}
              </TRow>
              <TRow>
                <Td className="text-xs text-muted">Benchmark</Td>
                {chosen.map((run) => (
                  <Td key={run.id} align="right" className="whitespace-nowrap text-xs">
                    {runBenchmark(run.config)}
                  </Td>
                ))}
              </TRow>
              <TRow>
                <Td className="text-xs text-muted">Saved</Td>
                {chosen.map((run) => (
                  <Td key={run.id} align="right" className="whitespace-nowrap text-xs">
                    {formatIstDate(run.created_at)}
                  </Td>
                ))}
              </TRow>
              {COMPARE_METRICS.map((metric) => {
                const winner = bestRunIndex(chosen, metric);
                return (
                  <TRow key={metric.key}>
                    <Td className="text-xs text-muted">{metric.label}</Td>
                    {chosen.map((run, index) => (
                      <Td
                        key={run.id}
                        align="right"
                        numeric
                        className={cn(
                          'font-medium',
                          index === winner && 'bg-primary/10 text-primary',
                        )}
                      >
                        {metric.format(run.kpis[metric.key])}
                        {index === winner ? <span className="sr-only"> (best)</span> : null}
                      </Td>
                    ))}
                  </TRow>
                );
              })}
            </tbody>
          </Table>

          {chosen.length < 2 ? (
            <p className="text-xs text-muted">
              Tick at least one more run to see which settings differ.
            </p>
          ) : (
            <div className="space-y-2">
              <h4 className="text-sm font-semibold text-foreground">
                Settings that differ ({differences.length})
              </h4>
              {differences.length === 0 ? (
                <p className="text-xs text-muted">
                  No settings differ. These runs used the same configuration.
                </p>
              ) : (
                <Table stickyFirstCol>
                  <THead>
                    <Th>Setting</Th>
                    {chosen.map((run) => (
                      <Th key={run.id} align="right" className="normal-case tracking-normal">
                        {runName(run)}
                      </Th>
                    ))}
                  </THead>
                  <tbody>
                    {differences.map((row) => (
                      <TRow key={row.key}>
                        <Td className="text-xs text-muted">{row.label}</Td>
                        {row.values.map((value, index) => (
                          <Td
                            key={chosen[index]?.id ?? index}
                            align="right"
                            className="max-w-64 break-words text-xs"
                          >
                            {value}
                          </Td>
                        ))}
                      </TRow>
                    ))}
                  </tbody>
                </Table>
              )}
            </div>
          )}
        </>
      )}
    </ResultSection>
  );
}
