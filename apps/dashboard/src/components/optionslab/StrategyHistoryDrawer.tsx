/**
 * Strategies and baskets › History: one saved strategy's days from the evening run, which the
 * Runs page used to list (it was removed 2026-10-28; `/optionslab/runs?strategy=<id>` lands
 * here). A run per strategy version (`strategyHistory`): the saved version in ₹ per lot, an
 * older one as a total, since its lot count is not known. A day opens its trade log.
 *
 * Read-only over GET /api/backtest/legwise/results, which the page has already fetched.
 */

import { useState } from 'react';

import { EMPTY, formatDay, formatInr, formatInt, formatPct } from '../../lib/format';
import {
  type LegwiseRunRow,
  NET_UNIT_LABEL,
  type OptionsRun,
  legwiseStatsOf,
  strategyHistory,
} from '../../lib/optionsRuns';
import type { SavedStrategy } from '../../types/legwise';
import { Drawer } from '../ui/Drawer';
import { Select } from '../ui/Input';
import { StatCard } from '../ui/StatCard';
import { StateMessage } from '../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { CumulativeLines, TradeLog, pnlClass } from './shared';

type RunDay = Extract<OptionsRun['source'], { engine: 'legwise' }>['rows'][number];

function periodOf(run: OptionsRun): string {
  return run.from === run.to
    ? formatDay(run.from)
    : `${formatDay(run.from)} → ${formatDay(run.to)}`;
}

function versionLabel(run: OptionsRun, savedSha: string): string {
  const short = run.version ? run.version.slice(0, 7) : 'unknown';
  const which = run.version === savedSha ? 'saved version' : 'older version';
  return `${which} ${short} · ${periodOf(run)} · ${formatInt(run.days)} ${run.days === 1 ? 'day' : 'days'}`;
}

function DayRows({
  day,
  divisor,
  unit,
  open,
  onToggle,
}: {
  day: RunDay;
  divisor: number;
  unit: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <TRow onClick={onToggle} selected={open}>
        <Td numeric className="whitespace-nowrap">
          {formatDay(day.day)} {open ? '▾' : '▸'}
        </Td>
        <Td align="right" numeric>
          {formatInt(day.trades.length)}
        </Td>
        <Td align="right" numeric className={pnlClass(day.net)} title={unit}>
          {formatInr(day.net / divisor)}
        </Td>
        <Td align="right" numeric title={unit}>
          {formatInr(day.worst_mtm / divisor)}
        </Td>
        <Td className="text-xs text-muted">
          {[day.stopped_by, ...day.notes].filter(Boolean).join('; ')}
        </Td>
      </TRow>
      {open ? (
        <tr>
          <td colSpan={5} className="bg-surface-2/40 px-3 py-3">
            <TradeLog trades={day.trades} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function RunDetail({ run }: { run: OptionsRun }) {
  const [openDay, setOpenDay] = useState<string | null>(null);
  if (run.source.engine !== 'legwise') return null;
  const stats = legwiseStatsOf(run);
  const unit = NET_UNIT_LABEL[run.netUnit];
  const divisor = run.source.lots ?? 1;
  // Newest day first, as the old Runs page listed them.
  const rows = [...run.source.rows].reverse();
  return (
    <div className="space-y-4">
      {run.current === false ? (
        <p className="text-xs text-warning">
          The strategy has changed since these days were saved; they are its older settings.
        </p>
      ) : null}
      {stats ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            label={`Net ${unit}`}
            value={formatInr(stats.total)}
            tone={stats.total >= 0 ? 'positive' : 'negative'}
          />
          <StatCard
            label="Win rate"
            value={stats.winRate === null ? EMPTY : formatPct(stats.winRate, 0)}
            note={`${formatInt(stats.up)} of ${formatInt(stats.days)} days`}
          />
          <StatCard
            label="Worst day"
            value={stats.worst === null ? EMPTY : formatInr(stats.worst)}
            note={unit}
          />
          <StatCard label="Max drawdown" value={formatInr(stats.maxDrawdown)} note={unit} />
        </div>
      ) : null}
      {stats && stats.cumulative.length > 1 ? (
        <CumulativeLines lines={[{ id: run.strategy, points: stats.cumulative }]} />
      ) : null}
      <Table maxHeight={420} stickyFirstCol>
        <THead>
          <Th>Day</Th>
          <Th align="right">Trades</Th>
          <Th align="right">Net {unit}</Th>
          <Th align="right">Worst MTM {unit}</Th>
          <Th>Note</Th>
        </THead>
        <tbody>
          {rows.map((day) => (
            <DayRows
              key={day.day}
              day={day}
              divisor={divisor}
              unit={unit}
              open={openDay === day.day}
              onToggle={() => setOpenDay(openDay === day.day ? null : day.day)}
            />
          ))}
        </tbody>
      </Table>
    </div>
  );
}

export function StrategyHistoryDrawer({
  strategy,
  results,
  resultsError,
  onClose,
}: {
  /** The strategy whose history is open; null keeps the drawer closed. */
  strategy: SavedStrategy | null;
  results: readonly LegwiseRunRow[] | null;
  resultsError: string | null;
  onClose: () => void;
}) {
  const runs = strategy && results ? strategyHistory(strategy, results) : [];
  const [picked, setPicked] = useState<string | null>(null);
  const run = runs.find((r) => r.key === picked) ?? runs[0] ?? null;
  return (
    <Drawer
      open={strategy !== null}
      onOpenChange={(open) => {
        if (!open) {
          setPicked(null);
          onClose();
        }
      }}
      size="lg"
      title={strategy ? `${strategy.name} · History` : 'History'}
      subtitle="Every day the evening run has saved for this strategy. Net is ₹ per lot for the saved version."
    >
      {strategy === null ? null : results === null ? (
        resultsError ? (
          <StateMessage
            variant="error"
            title="Couldn't load the saved results"
            description={resultsError}
          />
        ) : (
          <p className="text-sm text-muted">Loading the saved results…</p>
        )
      ) : runs.length === 0 ? (
        <StateMessage
          variant="empty"
          title="No saved days"
          description="The evening run has not saved a day for this strategy yet."
        />
      ) : (
        <div className="space-y-4">
          {resultsError ? (
            <p className="text-xs text-warning">
              The saved results could not be refreshed ({resultsError}); these are the last ones
              read.
            </p>
          ) : null}
          {runs.length > 1 ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <label htmlFor="strategy-history-version">Version</label>
              <Select
                id="strategy-history-version"
                value={run?.key ?? ''}
                onChange={(event) => setPicked(event.target.value)}
                className="w-auto"
              >
                {runs.map((r) => (
                  <option key={r.key} value={r.key}>
                    {versionLabel(r, strategy.sha)}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          {run ? <RunDetail key={run.key} run={run} /> : null}
        </div>
      )}
    </Drawer>
  );
}
