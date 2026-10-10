'use client';

import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Layers,
  Star,
} from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';

import { useAppRoute } from '../../../hooks/useAppRoute';
import { fetchCached, usePolledResource } from '../../../hooks/usePolledResource';
import { useQueryState } from '../../../hooks/useQueryState';
import { apiDelete, apiPatch, apiPost } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import {
  EMPTY,
  formatDay,
  formatInt,
  formatIstDate,
  formatIstDateTimeShort,
  formatNumber,
  formatPct,
  formatPp,
} from '../../../lib/format';
import {
  MAX_COMPARE,
  type SavedRunSortKey,
  type SortDirection,
  defaultSortDirection,
  differingSettings,
  sortSavedRuns,
  toggleSelection,
} from '../../../lib/momentumCompare';
import { MAX_FOLLOWED, isFollowed } from '../../../lib/momentumFavourites';
import { type FindingAction, savedFindings, tradableTwin } from '../../../lib/momentumFindings';
import {
  CHANGE,
  DATASET_SHORT,
  type DatasetFilter,
  type StatusFilter,
  TRUST,
  asSavedRun,
  cagrMove,
  extendedKpis,
  extendedSentence,
  matchesStrategy,
  strategyCounts,
  strategyName,
  universeTag,
} from '../../../lib/momentumSaved';
import {
  hydrateMomentumSavedFromStorage,
  useMomentumSavedStore,
} from '../../../store/momentumSaved';
import type {
  MomentumWeeklyStatus,
  SavedStrategiesResponse,
  SavedStrategy,
} from '../../../types/momentum';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Input } from '../../ui/Input';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { StateMessage } from '../../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../../ui/Table';
import { toast } from '../../ui/Toast';
import { MomentumCompare } from '../MomentumCompare';
import { momentumSettingsDefaults } from '../MomentumSettingsPanel';
import { MomentumListSkeleton } from '../MomentumSkeletons';
import { SavedFindingsCard } from './SavedFindingsCard';
import { SavedRunSparkline } from './SavedRunSparkline';
import { SavedStrategyDrawer } from './SavedStrategyDrawer';
import { StrategyStatusMenu } from './StrategyStatusMenu';

export const SAVED_STRATEGIES_URL = '/api/momentum/saved-strategies';
const DATASETS = ['etf', 'stock', 'custom_index', 'broad'] as const;

const DATASET_FILTERS: ReadonlyArray<{ value: DatasetFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'broad', label: 'Broad' },
  { value: 'etf', label: 'ETF' },
  { value: 'stock', label: 'Stocks' },
  { value: 'custom_index', label: 'Custom Index' },
];
const STATUS_FILTERS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: 'any', label: 'Any status' },
  { value: 'favourites', label: 'Favourites' },
  { value: 'paper', label: 'Paper' },
  { value: 'invested', label: 'Invested' },
  { value: 'watching', label: 'Watching' },
];
const METRICS: ReadonlyArray<{ key: SavedRunSortKey; label: string }> = [
  { key: 'cagr', label: 'CAGR' },
  { key: 'excess_cagr', label: 'Edge' },
  { key: 'max_drawdown', label: 'Max DD' },
  { key: 'sharpe', label: 'Sharpe' },
];
const LIMIT_MESSAGE = `Compare takes up to ${MAX_COMPARE} strategies. Untick one to add another.`;
const GROUP_HINT =
  'One favourite made of the ticked strategies: one status and one of the 8 Paper + Invested places. Each is still run and journalled every Friday, and This week shows them as its sleeves.';

/** Custom Index and Broad price through the same stock layer as Stock mode, so they share the
 * "stock" readiness key of /weekly/status. */
function readinessKey(dataset: string): 'etf' | 'stock' {
  return dataset === 'etf' ? 'etf' : 'stock';
}

interface MergePlan {
  merges: Array<{ dataset: string; runs: Array<{ id: string; name: string | null }> }>;
  conflicts: unknown[];
  runs: number;
  strategies: number;
}

function SortHeader({
  label,
  sortKey,
  active,
  direction,
  align = 'left',
  onSort,
}: {
  label: string;
  sortKey: SavedRunSortKey;
  active: boolean;
  direction: SortDirection;
  align?: 'left' | 'right';
  onSort: (key: SavedRunSortKey) => void;
}) {
  const Icon = !active ? ArrowUpDown : direction === 'asc' ? ArrowUp : ArrowDown;
  return (
    <Th
      dense
      align={align}
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          'inline-flex items-center gap-1 rounded uppercase tracking-wider hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          active && 'text-foreground',
        )}
      >
        {label}
        <Icon className={cn('h-3 w-3', !active && 'opacity-50')} aria-hidden />
      </button>
    </Th>
  );
}

/**
 * Saved runs (BL-052): one row per strategy (every run of one set of settings) across every
 * dataset, followed favourites first, with how far each result can be trusted and whether its
 * latest run moved it. A row opens the strategy's drawer (`?strategy=<id>`).
 */
export function SavedStrategiesView({
  onOpenInBacktest,
  onRerun,
  onChanged,
}: {
  onOpenInBacktest: (strategy: SavedStrategy) => void;
  onRerun: (strategy: SavedStrategy) => void;
  /** After any change here (the Backtest page's overlays and counts follow). */
  onChanged: () => void;
}) {
  const saved = usePolledResource<SavedStrategiesResponse>(SAVED_STRATEGIES_URL, { cache: true });
  const strategies = saved.data?.strategies ?? [];
  const ignoredFields = saved.data?.ignored_fields ?? {};
  const [datasetFilter, setDatasetFilter] = useState<DatasetFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('any');
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SavedRunSortKey>('saved');
  const [direction, setDirection] = useState<SortDirection>('desc');
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [groupDraft, setGroupDraft] = useState<string | null>(null);
  const [openId, setOpenId] = useQueryState('strategy');
  const [defaults, setDefaults] = useState<Record<string, Record<string, unknown>>>({});
  const merge = usePolledResource<MergePlan>(`${SAVED_STRATEGIES_URL}/merge`, { cache: true });
  // Whether a favourite could produce a signal right now: a blocked headline shows here before
  // Friday instead of as a missing Telegram message.
  const weekly = usePolledResource<MomentumWeeklyStatus>('/api/momentum/weekly/status', {
    cache: true,
  });
  function blocked(strategy: SavedStrategy): string | null {
    if (!strategy.favorite || strategy.member_of || strategy.group || !weekly.data) return null;
    const item = weekly.data.datasets.find((d) => d.key === readinessKey(strategy.dataset));
    if (!item || item.ready) return null;
    return item.through
      ? `Data only through ${formatDay(item.through)}: this week's data isn't ingested yet.`
      : 'No data ingested yet.';
  }

  // Each dataset's defaults, for automatic names and "different from the defaults" (only for
  // the datasets that have a strategy; the meta response is cached for the session).
  const presentKey = [...new Set(strategies.map((s) => s.dataset))].sort().join(',');
  useEffect(() => {
    for (const dataset of presentKey.split(',').filter(Boolean)) {
      if (!(DATASETS as readonly string[]).includes(dataset)) continue;
      void fetchCached<{ defaults?: Record<string, unknown> }>(
        `/api/momentum/meta?dataset=${dataset}`,
      ).then((response) => {
        if (response.ok && response.data.defaults) {
          const values = momentumSettingsDefaults(response.data.defaults);
          setDefaults((current) => ({ ...current, [dataset]: values }));
        }
      });
    }
  }, [presentKey]);

  const nameOf = useMemo(() => {
    const names = new Map<string, string>();
    const visit = (strategy: SavedStrategy) => {
      names.set(
        strategy.id,
        strategyName(strategy, defaults[strategy.dataset], ignoredFields[strategy.dataset] ?? []),
      );
      for (const member of strategy.members ?? []) visit(member);
    };
    for (const strategy of strategies) visit(strategy);
    return (strategy: SavedStrategy) => names.get(strategy.id) ?? strategy.name;
  }, [strategies, defaults, ignoredFields]);

  const all = useMemo(() => strategies.flatMap((s) => [s, ...(s.members ?? [])]), [strategies]);
  const counts = useMemo(() => strategyCounts(strategies), [strategies]);
  const followed = saved.data
    ? strategies.filter((s) => !s.member_of && isFollowed(s.status)).length
    : null;
  const atLimit = followed !== null && followed >= MAX_FOLLOWED;
  const totalRuns = all.filter((s) => !s.group).reduce((sum, s) => sum + s.runs, 0);

  const shown = useMemo(() => {
    const visible = strategies.filter((s) =>
      matchesStrategy(s, nameOf(s), datasetFilter, statusFilter, query),
    );
    const byId = new Map(visible.map((s) => [s.id, s]));
    const sorted = sortSavedRuns(
      visible.map((s) => asSavedRun(s, nameOf(s))),
      sortKey,
      direction,
    ).map((run) => byId.get(run.id) as SavedStrategy);
    return {
      followed: sorted.filter((s) => isFollowed(s.status)),
      other: sorted.filter((s) => !isFollowed(s.status)),
    };
  }, [strategies, nameOf, datasetFilter, statusFilter, query, sortKey, direction]);

  const selectedIds = selected.filter((id) => all.some((s) => s.id === id && !s.group));
  const selectedStrategies = selectedIds
    .map((id) => all.find((s) => s.id === id))
    .filter((s): s is SavedStrategy => s !== undefined);
  const settingsDiffer =
    selectedStrategies.length >= 2
      ? differingSettings(selectedStrategies.map((s) => ({ dataset: s.dataset, ...s.config })))
          .length
      : 0;
  const groupable = selectedStrategies.filter(
    (s) => !s.member_of && s.dataset === selectedStrategies[0]?.dataset,
  );
  const opened = all.find((s) => s.id === openId) ?? null;
  const openedTwin = opened ? tradableTwin(opened, all, ignoredFields.broad ?? []) : null;

  // Findings (Phase 3): below the list and the compare bar; Hide is remembered in this browser.
  const findings = useMemo(
    () => savedFindings(strategies, nameOf, ignoredFields),
    [strategies, nameOf, ignoredFields],
  );
  const findingsHidden = useMomentumSavedStore((state) => state.findingsHidden);
  const setFindingsHidden = useMomentumSavedStore((state) => state.setFindingsHidden);
  useEffect(() => hydrateMomentumSavedFromStorage(), []);
  const { navigate } = useAppRoute();
  const compareRef = useRef<HTMLDivElement>(null);

  function act(action: FindingAction): void {
    if (action.kind === 'open') setOpenId(action.id);
    else if (action.kind === 'guide') navigate('guide', 'momentum', 'saved-runs');
    else {
      setSelected(action.ids);
      // After the compare card renders with the two ticked.
      window.setTimeout(() => compareRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    }
  }

  function done(): void {
    saved.refetch();
    merge.refetch();
    onChanged();
  }

  async function patchStrategy(id: string, body: Record<string, unknown>): Promise<boolean> {
    setError(null);
    const response = await apiPatch<SavedStrategy>(`${SAVED_STRATEGIES_URL}/${id}`, body);
    if (!response.ok) {
      setError(response.error);
      toast(response.error, 'error');
      return false;
    }
    // An All Fridays run is followed as a group of one sleeve per Friday (BL-087).
    if (response.data?.id !== id && response.data?.group) {
      toast(
        `"${response.data.name}" follows all ${formatInt(response.data.group.length)} Fridays as one group`,
      );
    }
    done();
    return true;
  }

  async function removeStrategy(id: string): Promise<boolean> {
    setError(null);
    const response = await apiDelete(`${SAVED_STRATEGIES_URL}/${id}`);
    if (!response.ok) {
      setError(response.error);
      return false;
    }
    if (openId === id) setOpenId(null);
    done();
    return true;
  }

  async function markReviewed(changeId: string): Promise<void> {
    const response = await apiPost(`/api/momentum/result-changes/${changeId}/reviewed`, {});
    if (!response.ok) setError(response.error);
    else done();
  }

  async function createGroup(): Promise<void> {
    const name = groupDraft?.trim();
    if (!name) return;
    const response = await apiPost('/api/momentum/saved-runs/groups', {
      name,
      members: groupable.map((s) => s.id),
    });
    if (!response.ok) {
      setError(response.error);
      return;
    }
    toast(`"${name}" is now one favourite of ${groupable.length} strategies`);
    setGroupDraft(null);
    setSelected([]);
    done();
  }

  async function applyMerge(): Promise<void> {
    const response = await apiPost<MergePlan>(`${SAVED_STRATEGIES_URL}/merge`, {});
    if (!response.ok) {
      setError(response.error);
      return;
    }
    toast(`Folded ${response.data.runs} saved runs into ${response.data.strategies} strategies`);
    merge.refetch();
    done();
  }

  function sortBy(key: SavedRunSortKey): void {
    if (key === sortKey) setDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setDirection(defaultSortDirection(key));
    }
  }

  function toggleCompare(id: string): void {
    const next = toggleSelection(selectedIds, id);
    if (next.refused) {
      toast(LIMIT_MESSAGE, 'info');
      return;
    }
    setSelected(next.selected);
  }

  const sortProps = (key: SavedRunSortKey) => ({
    sortKey: key,
    active: sortKey === key,
    direction,
    onSort: sortBy,
  });

  function row(strategy: SavedStrategy, member = false) {
    const name = nameOf(strategy);
    const kpis = strategy.latest.kpis;
    const trust = strategy.trust ? TRUST[strategy.trust] : null;
    const change = strategy.change ? CHANGE[strategy.change.label] : null;
    const isGroup = strategy.group !== null;
    const isOpen = expanded.includes(strategy.id);
    const ticked = selectedIds.includes(strategy.id);
    const universe = universeTag(strategy);
    const extended = isGroup ? null : extendedKpis(kpis);
    const memberCagrs = (strategy.members ?? [])
      .map((m) => m.latest.kpis.cagr)
      .filter((v): v is number => typeof v === 'number');
    return (
      <TRow
        key={strategy.id}
        selected={ticked || openId === strategy.id}
        onClick={() => setOpenId(strategy.id)}
      >
        <Td dense className="w-8">
          {isGroup ? (
            <button
              type="button"
              aria-label={isOpen ? `Hide the members of ${name}` : `Show the members of ${name}`}
              aria-expanded={isOpen}
              className="text-muted hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                setExpanded((list) =>
                  isOpen ? list.filter((id) => id !== strategy.id) : [...list, strategy.id],
                );
              }}
            >
              {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
          ) : (
            <input
              type="checkbox"
              className="accent-primary"
              aria-label={`Compare ${name}`}
              checked={ticked}
              onClick={(event) => event.stopPropagation()}
              onChange={() => toggleCompare(strategy.id)}
            />
          )}
        </Td>
        <Td dense className="w-8">
          {member ? null : (
            <button
              type="button"
              aria-label={
                strategy.favorite
                  ? `${name} is a favourite`
                  : strategy.followed_by
                    ? `${name} is followed on all Fridays`
                    : `Make ${name} a favourite (Watching)`
              }
              title={
                strategy.favorite
                  ? 'A favourite: set its status on the right'
                  : strategy.followed_by
                    ? 'Followed on all Fridays as a group: set its status on the group'
                    : 'Make it a favourite (Watching)'
              }
              className={
                strategy.favorite || strategy.followed_by
                  ? 'text-warning'
                  : 'text-faint hover:text-foreground'
              }
              onClick={(event) => {
                event.stopPropagation();
                if (!strategy.favorite && !strategy.followed_by) {
                  void patchStrategy(strategy.id, { status: 'watching' });
                }
              }}
            >
              <Star
                className={cn(
                  'h-4 w-4',
                  (strategy.favorite || strategy.followed_by) && 'fill-current',
                )}
                aria-hidden
              />
            </button>
          )}
        </Td>
        <Td
          className={cn('max-w-[16rem]', member && 'pl-8')}
          title={strategy.notes ? `${name}\n${strategy.notes}` : name}
        >
          <span className="flex items-center gap-1.5">
            <span className={cn('truncate', member ? 'text-muted' : 'font-medium text-foreground')}>
              {name}
            </span>
            {strategy.active ? (
              <Badge tone="primary" dot>
                Headline
              </Badge>
            ) : null}
            {isGroup ? <Badge tone="neutral">Group · {strategy.group?.length}</Badge> : null}
            {strategy.name_typed || isGroup ? (
              // An automatic name starts with its dataset; a typed one says it here.
              <span className="shrink-0 text-xs text-faint">
                {DATASET_SHORT[strategy.dataset] ?? strategy.dataset}
              </span>
            ) : null}
            {universe && !isGroup ? (
              <span className="shrink-0 text-xs text-faint" title="Which stocks this ranks">
                · {universe}
              </span>
            ) : null}
          </span>
        </Td>
        <Td
          align="right"
          numeric
          className={strategy.runs > 1 ? '' : 'text-faint'}
          title={`${strategy.runs} runs, ${strategy.repeats} of them repeats`}
        >
          {isGroup ? EMPTY : `×${strategy.runs}`}
        </Td>
        <Td dense className="whitespace-nowrap">
          {isGroup ? null : <SavedRunSparkline values={strategy.latest.strategy} name={name} />}
        </Td>
        <Td dense align="right" numeric className="whitespace-nowrap">
          {isGroup && memberCagrs.length
            ? `${formatPct(Math.min(...memberCagrs), 0)}–${formatPct(Math.max(...memberCagrs), 0)}`
            : formatPct(kpis.cagr)}
          {extended ? (
            <span className="text-faint" title={extendedSentence(extended)}>
              {' '}
              · {formatPct(extended.cagr, 0)}
            </span>
          ) : null}
        </Td>
        <Td
          align="right"
          numeric
          className={(kpis.excess_cagr ?? 0) >= 0 ? 'text-positive' : 'text-negative'}
        >
          {isGroup ? EMPTY : formatPp(kpis.excess_cagr)}
        </Td>
        <Td dense align="right" numeric className="text-negative">
          {isGroup ? EMPTY : formatPct(kpis.max_drawdown)}
        </Td>
        <Td dense align="right" numeric>
          {isGroup ? EMPTY : formatNumber(kpis.sharpe, 2)}
        </Td>
        <Td dense className="whitespace-nowrap">
          <span className="flex items-center gap-1">
            {trust ? (
              <span title={trust.hint}>
                <Badge tone={trust.tone}>{trust.label}</Badge>
              </span>
            ) : null}
            {change && strategy.change ? (
              <span
                title={`Result moved ${formatPp(cagrMove(strategy.change))} CAGR on its latest run: ${change.label}. ${change.hint}`}
              >
                <Badge tone={change.tone}>
                  ↻{' '}
                  {formatNumber((cagrMove(strategy.change) ?? Number.NaN) * 100, 1, { sign: true })}
                </Badge>
              </span>
            ) : null}
          </span>
        </Td>
        <Td dense onClick={(event) => event.stopPropagation()}>
          {member ? (
            <span className="text-xs text-faint">follows the group</span>
          ) : strategy.favorite ? (
            <span className="flex items-center gap-1.5">
              <StrategyStatusMenu
                name={name}
                status={strategy.status}
                isGroup={isGroup}
                followed={followed}
                atLimit={atLimit}
                onChange={(status) => void patchStrategy(strategy.id, { status })}
              />
              {blocked(strategy) ? (
                <span title={blocked(strategy) ?? undefined}>
                  <Badge tone="warning" dot>
                    Blocked this week
                  </Badge>
                </span>
              ) : null}
            </span>
          ) : (
            <span className="text-xs text-faint">
              {strategy.followed_by ? 'followed on all Fridays' : '☆ to follow'}
            </span>
          )}
        </Td>
        <Td dense className="text-xs text-muted" title={formatIstDateTimeShort(strategy.last_run)}>
          {formatIstDate(strategy.last_run)}
        </Td>
      </TRow>
    );
  }

  function section(title: string, hint: string, list: SavedStrategy[]) {
    if (list.length === 0) return null;
    return (
      <Fragment key={title}>
        <tr>
          <td
            colSpan={12}
            className="border-b border-border px-3 pb-1.5 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-faint"
          >
            {title}
            <span className="ml-2 font-normal normal-case tracking-normal">{hint}</span>
          </td>
        </tr>
        {list.map((strategy) => (
          <Fragment key={strategy.id}>
            {row(strategy)}
            {expanded.includes(strategy.id)
              ? (strategy.members ?? []).map((m) => row(m, true))
              : null}
          </Fragment>
        ))}
      </Fragment>
    );
  }

  const nothingShown = shown.followed.length + shown.other.length === 0;
  const unreviewed = saved.data?.unreviewed ?? 0;

  return (
    <div className="space-y-4">
      {saved.error && !saved.data ? (
        <StateMessage variant="error" title="Could not load saved runs" description={saved.error} />
      ) : null}
      {error ? (
        <StateMessage
          variant="error"
          title="Could not update the saved strategy"
          description={error}
        />
      ) : null}
      {merge.data && merge.data.merges.length > 0 ? (
        <Card className="flex flex-wrap items-center gap-3 border-info/40">
          <span className="text-sm">
            {merge.data.runs} saved runs share their settings but are not yet under one strategy
            (saved by older code): fold them into{' '}
            {merge.data.strategies === 1 ? 'one strategy' : `${merge.data.strategies} strategies`}.
            Nothing is deleted; each run stays in its strategy&apos;s history.
          </span>
          <span className="grow" />
          <Button size="sm" variant="primary" onClick={() => void applyMerge()}>
            Fold them
          </Button>
        </Card>
      ) : null}

      {/* Rows are one line (the analytics table rule): long names are cut, full text on hover. */}
      <Card className="p-0 [&_td]:whitespace-nowrap">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">Strategies</h2>
          <span className="text-xs text-faint">
            {saved.data
              ? `${strategies.length} strategies · ${totalRuns} runs · all datasets`
              : 'Loading…'}
          </span>
          {unreviewed > 0 ? (
            <Badge tone="warning">
              {unreviewed} moved result{unreviewed === 1 ? '' : 's'} to review
            </Badge>
          ) : null}
          <span className="grow" />
          <SegmentedControl
            ariaLabel="Dataset"
            size="sm"
            value={datasetFilter}
            onChange={setDatasetFilter}
            options={DATASET_FILTERS.filter(
              (f) => f.value === 'all' || counts.dataset[f.value] > 0,
            ).map((f) => ({
              value: f.value,
              label: f.value === 'all' ? f.label : `${f.label} ${counts.dataset[f.value]}`,
            }))}
          />
          <SegmentedControl
            ariaLabel="Status"
            size="sm"
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUS_FILTERS.map((f) => ({
              value: f.value,
              label: f.value === 'any' ? f.label : `${f.label} ${counts.status[f.value]}`,
            }))}
          />
          {followed !== null ? (
            <Badge tone={atLimit ? 'warning' : 'neutral'}>
              Paper + Invested {followed} of {MAX_FOLLOWED}
            </Badge>
          ) : null}
          <Input
            type="search"
            aria-label="Search saved strategies"
            placeholder="Search…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="w-44"
          />
        </div>
        {saved.loading && !saved.data ? (
          <div className="p-4">
            <MomentumListSkeleton rows={5} label="Loading saved strategies" />
          </div>
        ) : strategies.length === 0 ? (
          <p className="p-4 text-sm text-muted">
            Run a backtest: every finished run is saved here.
          </p>
        ) : nothingShown ? (
          <p className="p-4 text-sm text-muted">No saved strategy matches these filters.</p>
        ) : (
          <Table stickyFirstCol>
            <THead>
              <Th dense>
                <span className="sr-only">Compare</span>
              </Th>
              <Th dense>
                <span className="sr-only">Favourite</span>
              </Th>
              <SortHeader label="Strategy" {...sortProps('name')} />
              <Th dense align="right">
                Runs
              </Th>
              <Th dense>Equity</Th>
              {METRICS.map((metric) => (
                <SortHeader
                  key={metric.key}
                  label={metric.label}
                  align="right"
                  {...sortProps(metric.key)}
                />
              ))}
              <Th dense>Trust</Th>
              <Th dense>Status</Th>
              <SortHeader label="Last run" {...sortProps('saved')} />
            </THead>
            <tbody>
              {section(
                'Followed',
                'Paper and Invested, journalled every Friday · never pruned',
                shown.followed,
              )}
              {section(
                'Other strategies',
                'the newest 10 per dataset are kept; a star keeps one for good',
                shown.other,
              )}
            </tbody>
          </Table>
        )}
      </Card>

      {selectedStrategies.length > 0 ? (
        <Card className="flex flex-wrap items-center gap-2 border-primary/40 py-2.5">
          <Badge tone="info">{selectedStrategies.length} ticked</Badge>
          <span className="min-w-0 truncate text-sm">
            {selectedStrategies.map((s) => nameOf(s)).join('  vs  ')}
          </span>
          {selectedStrategies.length >= 2 ? (
            <span className="text-xs text-muted">
              · they differ in {settingsDiffer} setting{settingsDiffer === 1 ? '' : 's'}
            </span>
          ) : null}
          <span className="grow" />
          {groupable.length >= 2 && groupable.length === selectedStrategies.length ? (
            <Button
              size="sm"
              variant="secondary"
              title={GROUP_HINT}
              onClick={() => setGroupDraft('')}
            >
              <Layers className="h-3.5 w-3.5" aria-hidden />
              Group as one favourite
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
            Clear
          </Button>
        </Card>
      ) : null}

      {selectedStrategies.length > 0 ? (
        <div ref={compareRef}>
          <Card>
            <MomentumCompare
              runs={all.filter((s) => !s.group).map((s) => asSavedRun(s, nameOf(s)))}
              selectedIds={selectedIds}
              onSelectedIdsChange={setSelected}
              picker={false}
            />
          </Card>
        </div>
      ) : null}

      <SavedFindingsCard
        findings={findings}
        hidden={findingsHidden}
        onHiddenChange={setFindingsHidden}
        onAction={act}
      />

      <SavedStrategyDrawer
        strategy={opened}
        twin={openedTwin}
        twinName={openedTwin ? nameOf(openedTwin) : ''}
        name={opened ? nameOf(opened) : ''}
        defaults={opened ? defaults[opened.dataset] : undefined}
        ignored={opened ? (ignoredFields[opened.dataset] ?? []) : []}
        followed={followed}
        atLimit={atLimit}
        onClose={() => setOpenId(null)}
        onPatch={patchStrategy}
        onRemove={removeStrategy}
        onReviewed={markReviewed}
        onOpenInBacktest={onOpenInBacktest}
        onRerun={onRerun}
      />

      <Dialog.Root
        open={groupDraft !== null}
        onOpenChange={(open) => (open ? undefined : setGroupDraft(null))}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(460px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-6 shadow-elevated">
            <Dialog.Title className="text-base font-semibold tracking-tight text-foreground">
              Group {groupable.length} strategies as one favourite
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-muted">
              {GROUP_HINT}
            </Dialog.Description>
            <form
              className="mt-4 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void createGroup();
              }}
            >
              <Input
                aria-label="Group name"
                placeholder="e.g. Phase 6 ensemble"
                maxLength={64}
                value={groupDraft ?? ''}
                onChange={(event) => setGroupDraft(event.target.value)}
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setGroupDraft(null)}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={!groupDraft?.trim()}>
                  Make group
                </Button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

/** For the Momentum tab label: how many strategies, and how many moved results need a look
 * (a small summary, not the list). */
export function useSavedStrategiesSummary(): {
  count: number | null;
  unreviewed: number;
  refetch: () => void;
} {
  const summary = usePolledResource<{ count: number; unreviewed: number }>(
    `${SAVED_STRATEGIES_URL}/summary`,
    { cache: true },
  );
  return {
    count: summary.data ? summary.data.count : null,
    unreviewed: summary.data?.unreviewed ?? 0,
    refetch: summary.refetch,
  };
}
