/**
 * Options Lab › Runs: every options backtest in one list, newest first. YAML-engine runs come
 * from the run registry (GET /api/backtest/runs); leg-wise runs (builder experiments and the
 * evening job's daily results) from GET /api/backtest/legwise/results. Merging, filtering,
 * units and comparison live in lib/optionsRuns.ts.
 *
 * Money is never compared across units: a YAML run reports a total, a leg-wise run reports per
 * lot when the strategy's lot count is known. Every Net cell says which.
 */

import { X } from 'lucide-react';
import { useMemo, useState } from 'react';

import { useBacktestRun, useBacktestRuns } from '../../hooks/useBacktestRuns';
import { useLegwiseResults, useLegwiseStrategies } from '../../hooks/useLegwise';
import { cn } from '../../lib/cn';
import {
  EMPTY,
  formatDay,
  formatInr,
  formatInt,
  formatIstDateTimeShort,
  formatMultiple,
  formatNumber,
  formatPct,
} from '../../lib/format';
import {
  type MetricFormat,
  NET_UNIT_LABEL,
  type OptionsRun,
  RUN_KIND_LABEL,
  type RunKindFilter,
  canCompare,
  compareRuns,
  countByKind,
  filterRuns,
  headlineOfSummary,
  legwiseStatsOf,
  mergeRuns,
} from '../../lib/optionsRuns';
import type { Tone } from '../ui/Badge';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { Input } from '../ui/Input';
import { RefreshButton } from '../ui/RefreshButton';
import { SegmentedControl, type SegmentedOption } from '../ui/SegmentedControl';
import { SkeletonRows } from '../ui/Skeleton';
import { StatCard } from '../ui/StatCard';
import { StateMessage } from '../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { CumulativeLines, TradeLog, pnlClass } from './shared';
import { YamlResult } from './yaml/YamlResult';

/** How many YAML registry rows to ask for; the registry returns newest first. */
const YAML_RUN_LIMIT = 100;

const KIND_TONE: Record<OptionsRun['kind'], Tone> = {
  yaml: 'accent',
  builder: 'info',
  daily: 'neutral',
};

function formatMetric(value: number | null, format: MetricFormat): string {
  if (value === null) return EMPTY;
  switch (format) {
    case 'inr':
      return formatInr(value, { dp: 0 });
    case 'int':
      return formatInt(value);
    case 'pct':
      return formatPct(value, 0);
    case 'multiple':
      return formatMultiple(value, 2);
    default:
      return formatNumber(value, 2, { trim: true });
  }
}

function periodOf(run: OptionsRun): string {
  return run.from === run.to
    ? formatDay(run.from)
    : `${formatDay(run.from)} → ${formatDay(run.to)}`;
}

/** The YAML registry keeps headline figures only, so a stored run shows its KPIs. */
function YamlRunDetail({ run }: { run: OptionsRun }) {
  const id = run.source.engine === 'yaml' ? run.source.run.run_id : '';
  const { run: stored, loading, error } = useBacktestRun(id);
  if (run.source.engine !== 'yaml') return null;
  const summary = stored ?? run.source.run;
  return (
    <div className="space-y-2">
      {loading && !stored ? <p className="text-xs text-muted">Loading the stored run…</p> : null}
      {error ? (
        <p className="text-xs text-muted">
          Could not refresh this run from the registry; showing the list's figures.
        </p>
      ) : null}
      <YamlResult
        headline={headlineOfSummary(summary)}
        result={null}
        title={`${summary.strategy_id} · v${summary.strategy_version}`}
        description={`${periodOf(run)} · run ${summary.run_id}. The registry keeps headline figures only; per-session rows are not stored.`}
      />
    </div>
  );
}

function LegwiseRunDetail({ run }: { run: OptionsRun }) {
  const [openDay, setOpenDay] = useState<string | null>(null);
  if (run.source.engine !== 'legwise') return null;
  const stats = legwiseStatsOf(run);
  const unit = NET_UNIT_LABEL[run.netUnit];
  const divisor = run.source.lots ?? 1;
  const rows = run.source.rows;
  return (
    <Card>
      <CardHeader
        title={`${run.strategy} · ${RUN_KIND_LABEL[run.kind]}`}
        description={`${periodOf(run)} · ${formatInt(run.days)} days · net ${unit}${
          run.current === false ? ' · the strategy has changed since these days were saved' : ''
        }`}
      />
      {stats ? (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            label={`Net ${unit}`}
            value={formatInr(stats.total)}
            tone={stats.total >= 0 ? 'positive' : 'negative'}
          />
          <StatCard
            label="Win rate"
            value={formatPct(stats.winRate, 0)}
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
              open={openDay === day.day}
              onToggle={() => setOpenDay(openDay === day.day ? null : day.day)}
            />
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function DayRows({
  day,
  divisor,
  open,
  onToggle,
}: {
  day: OptionsRunDay;
  divisor: number;
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
        <Td align="right" numeric className={pnlClass(day.net)}>
          {formatInr(day.net / divisor)}
        </Td>
        <Td align="right" numeric>
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

type OptionsRunDay = Extract<OptionsRun['source'], { engine: 'legwise' }>['rows'][number];

function Comparison({ a, b, onClose }: { a: OptionsRun; b: OptionsRun; onClose: () => void }) {
  const rows = compareRuns(a, b);
  return (
    <Card>
      <CardHeader
        title="Compare two runs"
        description="Better value in each row is marked. Money rows are compared only when both runs use the same unit."
        actions={
          <Button size="sm" variant="ghost" onClick={onClose}>
            <X className="h-3.5 w-3.5" aria-hidden="true" /> Close
          </Button>
        }
      />
      {rows === null ? (
        <p className="text-sm text-muted">These two runs cannot be compared.</p>
      ) : (
        <Table>
          <THead>
            <Th>Metric</Th>
            <Th align="right">
              {a.strategy}
              <span className="block font-normal normal-case text-faint">{periodOf(a)}</span>
            </Th>
            <Th align="right">
              {b.strategy}
              <span className="block font-normal normal-case text-faint">{periodOf(b)}</span>
            </Th>
          </THead>
          <tbody>
            {rows.map((row) => (
              <TRow key={row.label}>
                <Td className="text-muted">{row.label}</Td>
                <Td
                  align="right"
                  numeric
                  className={cn(row.better === 'a' && 'font-semibold text-foreground')}
                >
                  {formatMetric(row.a, row.format)}
                  {row.better === 'a' ? ' ✓' : ''}
                </Td>
                <Td
                  align="right"
                  numeric
                  className={cn(row.better === 'b' && 'font-semibold text-foreground')}
                >
                  {formatMetric(row.b, row.format)}
                  {row.better === 'b' ? ' ✓' : ''}
                </Td>
              </TRow>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

export function RunsPanel() {
  const yaml = useBacktestRuns(YAML_RUN_LIMIT);
  const legwise = useLegwiseResults();
  const strategies = useLegwiseStrategies();
  const [kind, setKind] = useState<RunKindFilter>('all');
  const [text, setText] = useState('');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);

  const all = useMemo(
    () => mergeRuns(yaml.runs, legwise.data?.results ?? [], strategies.data ?? []),
    [yaml.runs, legwise.data, strategies.data],
  );
  const counts = useMemo(() => countByKind(all), [all]);
  const shown = useMemo(() => filterRuns(all, { kind, text }), [all, kind, text]);
  const byKey = useMemo(() => new Map(all.map((run) => [run.key, run])), [all]);
  const open = openKey ? (byKey.get(openKey) ?? null) : null;
  const [first, second] = picked.map((key) => byKey.get(key));
  const pair = first && second && canCompare(first, second) ? ([first, second] as const) : null;

  const loading = (yaml.loading && yaml.runs.length === 0) || (legwise.loading && !legwise.data);
  const yamlDown = yaml.error !== null;
  const legwiseDown = legwise.error !== null;

  const kindOptions: SegmentedOption<RunKindFilter>[] = (
    ['all', 'yaml', 'builder', 'daily'] as const
  ).map((value) => ({
    value,
    label: `${value === 'all' ? 'All' : RUN_KIND_LABEL[value]} ${formatInt(counts[value])}`,
  }));

  function togglePick(run: OptionsRun): void {
    setComparing(false);
    setPicked((current) => {
      if (current.includes(run.key)) return current.filter((key) => key !== run.key);
      // Keep the newest pick and one before it, of the same kind.
      const sameKind = current.filter((key) => byKey.get(key)?.kind === run.kind);
      return [...sameKind.slice(-1), run.key];
    });
  }

  return (
    <div className="space-y-5">
      <Card flush>
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-foreground">Runs</h2>
            <p className="mt-0.5 text-xs text-muted">
              Every options backtest, newest first: YAML engine runs, builder experiments and the
              evening job's daily results. Tick two runs of the same kind to compare them.
            </p>
          </div>
          <RefreshButton
            onClick={() => {
              yaml.refresh();
              legwise.refetch();
            }}
            loading={yaml.loading || legwise.loading}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 px-5 py-3">
          <SegmentedControl
            ariaLabel="Run kind"
            value={kind}
            options={kindOptions}
            onChange={setKind}
            size="sm"
          />
          <Input
            aria-label="Filter by strategy"
            placeholder="Filter by strategy"
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="w-56"
          />
          <span className="flex-1" />
          <Button
            size="sm"
            variant="primary"
            disabled={!pair}
            onClick={() => setComparing(true)}
            title={pair ? undefined : 'Tick two runs of the same kind'}
          >
            Compare {formatInt(picked.length)} / 2
          </Button>
        </div>
        {!legwiseDown && counts.builder === 0 ? (
          <p className="px-5 pb-3 text-xs text-muted">
            Builder experiments are stored by the backtest service but not listed by it yet, so they
            do not appear here.
          </p>
        ) : null}
        {yamlDown || legwiseDown ? (
          <p className="px-5 pb-3 text-xs text-muted">
            {yamlDown && legwiseDown
              ? "Can't reach the options backtest service right now."
              : yamlDown
                ? "Can't reach the YAML run registry right now; showing leg-wise runs only."
                : "Can't reach the leg-wise results right now; showing YAML runs only."}
          </p>
        ) : null}
        <div className="px-2 pb-2">
          {loading ? (
            <SkeletonRows rows={6} className="px-3 pt-2" />
          ) : shown.length === 0 ? (
            <StateMessage
              variant="empty"
              title={all.length === 0 ? 'No runs yet' : 'No runs match'}
              description={
                all.length === 0
                  ? 'Backtests from the Builder and the evening job appear here.'
                  : 'Change the kind or the strategy filter.'
              }
              className="m-3"
            />
          ) : (
            <Table maxHeight={560} stickyFirstCol>
              <THead>
                <Th>When</Th>
                <Th>Kind</Th>
                <Th>Strategy</Th>
                <Th>Period</Th>
                <Th align="right">Net</Th>
                <Th align="right">Days</Th>
                <Th align="center">Compare</Th>
              </THead>
              <tbody>
                {shown.map((run) => (
                  <TRow
                    key={run.key}
                    onClick={() => setOpenKey(openKey === run.key ? null : run.key)}
                    selected={openKey === run.key}
                  >
                    <Td numeric className="whitespace-nowrap text-muted">
                      {run.recordedAt ? formatIstDateTimeShort(run.recordedAt) : formatDay(run.to)}
                    </Td>
                    <Td>
                      <Badge tone={KIND_TONE[run.kind]}>{RUN_KIND_LABEL[run.kind]}</Badge>
                    </Td>
                    <Td>
                      <span className="font-medium">{run.strategy}</span>
                      {run.version ? (
                        <span className="ml-1.5 font-mono text-xs text-faint" title={run.version}>
                          {run.version.slice(0, 7)}
                        </span>
                      ) : null}
                    </Td>
                    <Td className="whitespace-nowrap text-muted">{periodOf(run)}</Td>
                    <Td align="right" numeric className={pnlClass(run.net)}>
                      {formatInr(run.net)}
                      <span className="ml-1 text-xs text-faint">{NET_UNIT_LABEL[run.netUnit]}</span>
                    </Td>
                    <Td align="right" numeric>
                      {formatInt(run.days)}
                    </Td>
                    <Td align="center">
                      <input
                        type="checkbox"
                        aria-label={`Compare ${run.strategy} ${periodOf(run)}`}
                        checked={picked.includes(run.key)}
                        onClick={(event) => event.stopPropagation()}
                        onChange={() => togglePick(run)}
                        className="h-4 w-4 accent-primary"
                      />
                    </Td>
                  </TRow>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </Card>

      {comparing && pair ? (
        <Comparison a={pair[0]} b={pair[1]} onClose={() => setComparing(false)} />
      ) : null}

      {open ? (
        open.source.engine === 'yaml' ? (
          <YamlRunDetail key={open.key} run={open} />
        ) : (
          <LegwiseRunDetail key={open.key} run={open} />
        )
      ) : null}
    </div>
  );
}
