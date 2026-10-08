'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { ArrowDown, ArrowUp, ArrowUpDown, Layers } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { usePolledResource } from '../../hooks/usePolledResource';
import { cn } from '../../lib/cn';
import { EMPTY, formatDay, formatIstDate, formatIstDateTimeShort } from '../../lib/format';
import {
  COMPARE_METRICS,
  MAX_COMPARE,
  type SavedRunSortKey,
  type SortDirection,
  completeConfig,
  defaultSortDirection,
  runPeriod,
  sortSavedRuns,
  toggleSelection,
} from '../../lib/momentumCompare';
import {
  FAVOURITE_STATUSES,
  MAX_FOLLOWED,
  STATUS_HINT,
  STATUS_LABEL,
  type SavedRunFilter,
  filterCounts,
  followedCount,
  groupOf,
  isFollowed,
  matchesFilter,
} from '../../lib/momentumFavourites';
import type { FavouriteStatus, MomentumSavedRun, MomentumWeeklyStatus } from '../../types/momentum';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { InfoTooltip } from '../ui/InfoTooltip';
import { Input } from '../ui/Input';
import { RadioMenu } from '../ui/RadioMenu';
import { SegmentedControl } from '../ui/SegmentedControl';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { toast } from '../ui/Toast';
import { MomentumCompare } from './MomentumCompare';
import { momentumSettingsDefaults } from './MomentumSettingsPanel';
import { MomentumListSkeleton } from './MomentumSkeletons';
import { type RenameState, SavedRunName } from './saved/SavedRunName';
import { SavedRunSparkline } from './saved/SavedRunSparkline';
import { SavedRunViewer } from './saved/SavedRunViewer';

type Dataset = 'etf' | 'stock' | 'custom_index' | 'broad';

const DATASET_NAMES: Record<Dataset, string> = {
  etf: 'ETF Rotation',
  stock: 'Nifty 50 Stocks',
  custom_index: 'Custom Index',
  broad: 'Broad Momentum',
};

const LIMIT_MESSAGE = `Compare takes up to ${MAX_COMPARE} runs. Untick one to add another.`;
const OVERLAY_DISABLED_REASON =
  'Not available for this run: the Backtest chart never draws the first run in the saved list as an overlay (it treats it as the run being shown).';
const TELEGRAM_CONFIRM =
  'It goes first on This week and its weekly signal is the one sent to Telegram. The current headline stays a favourite with its status, but is no longer sent.';
const GROUP_HINT =
  'One favourite made of the ticked runs: one status and one of the 8 Paper + Invested places. Each run is still evaluated and journalled every Friday, and This week shows them as its sleeves.';

const FILTERS: ReadonlyArray<{ value: SavedRunFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'favourites', label: 'Favourites' },
  { value: 'invested', label: 'Invested' },
  { value: 'paper', label: 'Paper' },
  { value: 'watching', label: 'Watching' },
];

/** Custom Index and Broad Momentum price through the same bhavcopy-backed stock layer as
 * Stock mode (see weekly.py's A5 gate investigation), so they share the "stock" readiness
 * dataset key from /weekly/status rather than each needing their own. */
function readinessKey(dataset: unknown): 'etf' | 'stock' {
  return dataset === 'stock' || dataset === 'custom_index' || dataset === 'broad' ? 'stock' : 'etf';
}

/** B3: whether a favourite could produce a signal right now, so a blocked active favourite
 * is visible before Friday rather than discovered from a missed Telegram message. */
function readiness(
  run: MomentumSavedRun,
  status: MomentumWeeklyStatus | null,
): { ready: boolean; detail: string } | null {
  if (!run.favorite || run.member_of || !status) return null;
  const item = status.datasets.find((d) => d.key === readinessKey(run.config.dataset));
  if (!item) return null;
  return {
    ready: item.ready,
    detail: item.ready
      ? `Data through ${formatDay(item.through)}`
      : item.through
        ? `Data only through ${formatDay(item.through)}: this week's data isn't ingested yet.`
        : 'No data ingested yet.',
  };
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

export function MomentumSavedRunsView({
  dataset,
  runs,
  loading = false,
  onRename,
  onToggleOverlay,
  onSetStatus,
  onSetActive,
  onCreateGroup,
  onRemove,
  onLoad,
}: {
  dataset: Dataset;
  runs: MomentumSavedRun[];
  /** The list has not arrived yet: show placeholders, never the "no runs" empty state. */
  loading?: boolean;
  /** May return a promise; the view waits for it before confirming or reporting the rename. */
  onRename: (id: string, name: string) => void | Promise<void>;
  onToggleOverlay: (id: string, overlay: boolean) => void;
  /** 'none' stops following the run. */
  onSetStatus: (id: string, status: FavouriteStatus | 'none') => void;
  onSetActive: (id: string) => void;
  /** Resolves true once the group exists (the parent shows any error above the table). */
  onCreateGroup: (name: string, members: string[]) => Promise<boolean>;
  onRemove: (id: string) => void;
  onLoad: (run: MomentumSavedRun) => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SavedRunFilter>('all');
  const [groupDraft, setGroupDraft] = useState<string | null>(null);
  const [groupSaving, setGroupSaving] = useState(false);
  const [sortKey, setSortKey] = useState<SavedRunSortKey>('saved');
  const [direction, setDirection] = useState<SortDirection>('desc');
  const [selected, setSelected] = useState<string[]>([]);
  const [refused, setRefused] = useState(false);
  const [rename, setRename] = useState<RenameState | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [confirmActiveId, setConfirmActiveId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  // Shares the Weekly signal tab's endpoint rather than threading its status down through
  // props — cheap to poll and keeps this view self-contained.
  const { data: status } = usePolledResource<MomentumWeeklyStatus>('/api/momentum/weekly/status', {
    cache: true,
  });
  // The dataset's default settings, so "Load settings" can hand the parent a complete config.
  const { data: meta } = usePolledResource<{ defaults?: Record<string, unknown> }>(
    `/api/momentum/meta?dataset=${dataset}`,
    { cache: true },
  );
  // Every dataset's favourites: the Paper + Invested cap counts across all of them.
  const favourites = usePolledResource<MomentumSavedRun[]>('/api/momentum/favorite-strategies', {
    cache: true,
  });
  const refetchFavourites = favourites.refetch;
  // A changed list (a status set, a group made) can move the cap; the first list is the one the
  // hook has just fetched with, so skip it.
  const seenRuns = useRef<MomentumSavedRun[] | null>(null);
  useEffect(() => {
    if (seenRuns.current !== null && seenRuns.current !== runs) refetchFavourites();
    seenRuns.current = runs;
  }, [runs, refetchFavourites]);
  const followed = favourites.data ? followedCount(favourites.data) : null;
  const atLimit = followed !== null && followed >= MAX_FOLLOWED;
  const counts = useMemo(() => filterCounts(runs), [runs]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = runs.filter(
      (run) => matchesFilter(run, filter) && (!needle || run.name.toLowerCase().includes(needle)),
    );
    return sortSavedRuns(filtered, sortKey, direction);
  }, [runs, query, filter, sortKey, direction]);

  // A removed run drops out of the comparison.
  const selectedIds = useMemo(
    () => selected.filter((id) => runs.some((run) => run.id === id)),
    [selected, runs],
  );
  const opened = runs.find((run) => run.id === openId) ?? null;
  const confirmRun = runs.find((run) => run.id === confirmActiveId) ?? null;
  const currentActive =
    favourites.data?.find((run) => run.active) ?? runs.find((run) => run.active) ?? null;
  // Runs that can join a new group: ticked, not groups, not already in one.
  const groupable = selectedIds.filter((id) => {
    const run = runs.find((item) => item.id === id);
    return run !== undefined && !run.group && !run.member_of;
  });

  async function createGroup(): Promise<void> {
    const name = groupDraft?.trim();
    if (!name || groupSaving) return;
    setGroupSaving(true);
    const ok = await onCreateGroup(name, groupable);
    setGroupSaving(false);
    if (ok) {
      toast(`"${name}" is now one favourite of ${groupable.length} runs`);
      setGroupDraft(null);
      setSelected([]);
    }
  }

  // A rename is confirmed by the refreshed list carrying the new name. If the parent's call has
  // returned and the name is still the old one, the save failed (the parent shows its reason
  // above the table): keep the typed text so it can be retried.
  useEffect(() => {
    if (!rename || rename.status !== 'saving') return;
    const run = runs.find((item) => item.id === rename.id);
    if (!run) {
      setRename(null);
    } else if (run.name === rename.submitted) {
      toast(`Renamed to "${run.name}"`);
      setRename(null);
    } else if (rename.settled) {
      setRename({
        ...rename,
        status: 'failed',
        error: rename.error ?? 'The name was not saved. Your text is kept: try again.',
      });
    }
  }, [rename, runs]);

  function sortBy(key: SavedRunSortKey): void {
    if (key === sortKey) {
      setDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setDirection(defaultSortDirection(key));
    }
  }

  function toggleCompare(id: string): void {
    const next = toggleSelection(selectedIds, id);
    setRefused(next.refused);
    if (next.refused) {
      toast(LIMIT_MESSAGE, 'info');
      return;
    }
    setSelected(next.selected);
  }

  function commitRename(run: MomentumSavedRun): void {
    if (!rename || rename.id !== run.id || rename.status === 'saving') return;
    const name = rename.draft.trim();
    if (!name) {
      setRename({ ...rename, status: 'failed', error: 'A name cannot be empty.' });
      return;
    }
    if (name === run.name) {
      setRename(null);
      return;
    }
    setRename({ ...rename, status: 'saving', submitted: name, settled: false, error: null });
    const settle = (error: string | null) =>
      setRename((current) =>
        current && current.id === run.id && current.status === 'saving'
          ? { ...current, settled: true, error }
          : current,
      );
    Promise.resolve()
      .then(() => onRename(run.id, name))
      .then(
        () => settle(null),
        (reason: unknown) =>
          settle(
            `Could not rename: ${reason instanceof Error ? reason.message : String(reason)}. Your text is kept.`,
          ),
      );
  }

  /**
   * The parent merges a loaded config over its current form, so a setting the saved run never
   * stored would keep whatever the form holds now. Completing the config with the dataset's
   * defaults first makes that merge a replace.
   */
  function loadSettings(run: MomentumSavedRun): void {
    if (meta?.defaults) {
      onLoad({
        ...run,
        config: completeConfig(momentumSettingsDefaults(meta.defaults), run.config),
      });
      toast(`Settings replaced with "${run.name}"`);
    } else {
      onLoad(run);
      toast(
        `Loaded "${run.name}". The dataset defaults had not arrived, so settings this run never stored keep their current values.`,
        'info',
      );
    }
    setOpenId(null);
  }

  const sortProps = (key: SavedRunSortKey) => ({
    sortKey: key,
    active: sortKey === key,
    direction,
    onSort: sortBy,
  });

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title={`Saved runs · ${DATASET_NAMES[dataset]}`}
          description={`${loading ? 'Loading the saved runs' : `${runs.length} runs`} for this dataset. Every favourite runs each Friday and is journalled; the headline is the one sent to Telegram.`}
          actions={
            followed !== null ? (
              <Badge tone={atLimit ? 'warning' : 'neutral'}>
                Paper + Invested {followed} of {MAX_FOLLOWED}
              </Badge>
            ) : null
          }
        />
        {loading && runs.length === 0 ? (
          <MomentumListSkeleton rows={4} label="Loading saved runs" />
        ) : runs.length === 0 ? (
          <p className="text-sm text-muted">Run a backtest to start a comparison.</p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
              <Input
                type="search"
                aria-label="Search saved runs"
                placeholder="Search by name…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="w-56"
              />
              <SegmentedControl
                ariaLabel="Show"
                size="sm"
                value={filter}
                onChange={setFilter}
                options={FILTERS.map((item) => ({
                  value: item.value,
                  label: `${item.label} ${counts[item.value]}`,
                }))}
              />
              <span className="text-xs text-muted">
                Showing {shown.length} of {runs.length}
              </span>
              <span className="ml-auto flex items-center gap-2 text-xs text-muted">
                {selectedIds.length} of {MAX_COMPARE} ticked to compare
                {groupable.length >= 2 ? (
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
                {selectedIds.length > 0 ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setSelected([]);
                      setRefused(false);
                    }}
                  >
                    Clear
                  </Button>
                ) : null}
              </span>
            </div>
            {refused ? (
              <output className="block mb-2 text-xs text-warning">{LIMIT_MESSAGE}</output>
            ) : null}
            {shown.length === 0 ? (
              <p className="text-sm text-muted">No saved run matches this filter.</p>
            ) : (
              <Table stickyFirstCol>
                <THead>
                  <SortHeader label="Name" {...sortProps('name')} />
                  <Th>Equity</Th>
                  <SortHeader label="Saved" {...sortProps('saved')} />
                  <SortHeader label="Period" {...sortProps('period')} />
                  {COMPARE_METRICS.map((metric) => (
                    <SortHeader
                      key={metric.key}
                      label={metric.short}
                      align="right"
                      {...sortProps(metric.key)}
                    />
                  ))}
                  <Th>Favourite</Th>
                  <Th>Overlay</Th>
                  <Th align="right">Actions</Th>
                </THead>
                <tbody>
                  {shown.map((run) => {
                    // The parent's chart skips the first run of the list as it arrived
                    // (unsorted) when drawing overlays, so its tick would do nothing.
                    const overlayDisabled = runs.indexOf(run) === 0;
                    const ready = readiness(run, status ?? null);
                    const ticked = selectedIds.includes(run.id);
                    const parent = groupOf(run, runs);
                    const memberNames = run.group
                      ? run.group.map((id) => runs.find((other) => other.id === id)?.name ?? id)
                      : [];
                    return (
                      <TRow key={run.id} selected={ticked}>
                        <Td className="min-w-52 max-w-80">
                          <div className="flex items-start gap-2">
                            <input
                              type="checkbox"
                              className="mt-1 accent-primary"
                              aria-label={`Compare ${run.name}`}
                              checked={ticked}
                              disabled={run.group !== null}
                              title={
                                run.group
                                  ? 'A group has no curve of its own to compare.'
                                  : undefined
                              }
                              onChange={() => toggleCompare(run.id)}
                            />
                            <div className="min-w-0 space-y-1">
                              <SavedRunName
                                name={run.name}
                                n={run.n}
                                rename={rename?.id === run.id ? rename : null}
                                onStart={() =>
                                  setRename({
                                    id: run.id,
                                    draft: run.name,
                                    status: 'editing',
                                    submitted: null,
                                    settled: false,
                                    error: null,
                                  })
                                }
                                onDraft={(draft) =>
                                  setRename((current) =>
                                    current && current.id === run.id
                                      ? { ...current, draft, status: 'editing', error: null }
                                      : current,
                                  )
                                }
                                onCommit={() => commitRename(run)}
                                onCancel={() => setRename(null)}
                              />
                              <div className="flex flex-wrap items-center gap-1">
                                {run.active ? (
                                  <Badge tone="primary" dot>
                                    Headline
                                  </Badge>
                                ) : null}
                                {run.group ? (
                                  <span title={memberNames.join(', ')}>
                                    <Badge tone="neutral">Group · {run.group.length} runs</Badge>
                                  </span>
                                ) : null}
                                {parent ? <Badge tone="neutral">In {parent.name}</Badge> : null}
                              </div>
                              {run.group ? (
                                <p
                                  className="truncate text-xs text-muted"
                                  title={memberNames.join(', ')}
                                >
                                  {memberNames.join(' · ')}
                                </p>
                              ) : null}
                            </div>
                          </div>
                        </Td>
                        <Td>
                          <SavedRunSparkline values={run.strategy} name={run.name} />
                        </Td>
                        <Td
                          className="whitespace-nowrap text-xs text-muted"
                          title={formatIstDateTimeShort(run.created_at)}
                        >
                          {formatIstDate(run.created_at)}
                        </Td>
                        <Td className="whitespace-nowrap text-xs text-muted">
                          {runPeriod(run.config)}
                        </Td>
                        {COMPARE_METRICS.map((metric) => {
                          const value = run.kpis[metric.key];
                          return (
                            <Td
                              key={metric.key}
                              align="right"
                              numeric
                              className={cn(
                                'whitespace-nowrap',
                                metric.key === 'excess_cagr' &&
                                  typeof value === 'number' &&
                                  (value > 0 ? 'text-positive' : value < 0 ? 'text-negative' : ''),
                              )}
                            >
                              {metric.format(value)}
                            </Td>
                          );
                        })}
                        <Td>
                          <div className="flex flex-col items-start gap-1">
                            {parent ? (
                              <span className="whitespace-nowrap text-xs text-muted">
                                Follows {parent.name}
                              </span>
                            ) : (
                              <RadioMenu
                                ariaLabel={`Favourite status of ${run.name}: ${run.status ? STATUS_LABEL[run.status] : 'not a favourite'}. Change it`}
                                value={run.status ?? 'none'}
                                valueLabel={
                                  run.status ? STATUS_LABEL[run.status] : 'Not a favourite'
                                }
                                heading="Favourite status"
                                options={[
                                  {
                                    value: 'none',
                                    label: 'Not a favourite',
                                    disabled: run.group !== null,
                                    title: run.group
                                      ? 'A group is always a favourite: remove the group instead.'
                                      : undefined,
                                  },
                                  ...FAVOURITE_STATUSES.map((value) => {
                                    const blocked =
                                      atLimit && isFollowed(value) && !isFollowed(run.status);
                                    return {
                                      value,
                                      label: STATUS_LABEL[value],
                                      disabled: blocked,
                                      title: blocked
                                        ? `${MAX_FOLLOWED} favourites are already Paper or Invested. Set one to Watching first.`
                                        : STATUS_HINT[value],
                                    };
                                  }),
                                ]}
                                footer={
                                  followed !== null
                                    ? `Paper + Invested: ${followed} of ${MAX_FOLLOWED}, across every dataset. Watching has no limit.`
                                    : undefined
                                }
                                onChange={(value) =>
                                  onSetStatus(run.id, value as FavouriteStatus | 'none')
                                }
                              />
                            )}
                            {run.active ? (
                              <span className="whitespace-nowrap text-xs font-medium text-primary">
                                Sent to Telegram
                              </span>
                            ) : run.favorite && !parent ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 whitespace-nowrap px-1.5"
                                aria-label={`Make ${run.name} the headline`}
                                disabled={atLimit && !isFollowed(run.status)}
                                onClick={() => setConfirmActiveId(run.id)}
                              >
                                Make headline
                              </Button>
                            ) : null}
                            {ready ? (
                              <span title={ready.detail}>
                                <Badge tone={ready.ready ? 'positive' : 'warning'} dot>
                                  {ready.ready ? 'Ready this week' : 'Blocked this week'}
                                </Badge>
                                <span className="sr-only">{ready.detail}</span>
                              </span>
                            ) : null}
                          </div>
                        </Td>
                        <Td>
                          {run.group ? null : (
                            <span className="flex items-center gap-1">
                              <label
                                className="flex items-center gap-1.5 text-xs text-muted"
                                title={overlayDisabled ? OVERLAY_DISABLED_REASON : undefined}
                              >
                                <input
                                  type="checkbox"
                                  className="accent-primary"
                                  aria-label={`Overlay ${run.name}`}
                                  checked={run.overlay}
                                  disabled={overlayDisabled}
                                  onChange={(event) =>
                                    onToggleOverlay(run.id, event.target.checked)
                                  }
                                />
                                <span className="sr-only">Overlay on the Backtest chart</span>
                              </label>
                              {overlayDisabled ? (
                                <InfoTooltip
                                  text={OVERLAY_DISABLED_REASON}
                                  label={`Why ${run.name} cannot be overlaid`}
                                />
                              ) : null}
                            </span>
                          )}
                        </Td>
                        <Td align="right">
                          <div className="flex justify-end gap-1.5 whitespace-nowrap">
                            {removeId === run.id ? (
                              <>
                                <Button
                                  size="sm"
                                  variant="danger"
                                  onClick={() => {
                                    onRemove(run.id);
                                    setRemoveId(null);
                                  }}
                                >
                                  {run.group ? 'Remove group (keeps its runs)' : 'Confirm remove'}
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setRemoveId(null)}>
                                  Cancel
                                </Button>
                              </>
                            ) : (
                              <>
                                {run.group ? null : (
                                  <>
                                    <Button
                                      size="sm"
                                      aria-label={`Open ${run.name}`}
                                      onClick={() => setOpenId(run.id)}
                                    >
                                      Open
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => loadSettings(run)}
                                    >
                                      Load settings
                                    </Button>
                                  </>
                                )}
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setRemoveId(run.id)}
                                >
                                  Remove
                                </Button>
                              </>
                            )}
                          </div>
                        </Td>
                      </TRow>
                    );
                  })}
                </tbody>
              </Table>
            )}
            <p className="mt-3 text-xs text-faint">
              The headline stays on top whatever the sort. Paper + Invested are capped at{' '}
              {MAX_FOLLOWED} across every dataset; a group takes one place. Equity is each
              run&apos;s stored weekly value over its own period ({EMPTY} when none was stored).
            </p>
          </>
        )}
      </Card>

      {runs.length > 0 ? (
        <Card>
          <MomentumCompare
            runs={runs.filter((run) => !run.group)}
            selectedIds={selectedIds}
            onSelectedIdsChange={setSelected}
            picker={false}
          />
        </Card>
      ) : null}

      <SavedRunViewer run={opened} onClose={() => setOpenId(null)} onLoad={loadSettings} />

      <Dialog.Root
        open={groupDraft !== null}
        onOpenChange={(open) => (open ? undefined : setGroupDraft(null))}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(460px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-6 shadow-elevated">
            <Dialog.Title className="text-base font-semibold tracking-tight text-foreground">
              Group {groupable.length} runs as one favourite
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-muted">
              {GROUP_HINT}
            </Dialog.Description>
            <ul className="mt-3 space-y-0.5 text-xs text-muted">
              {groupable.map((id) => (
                <li key={id} className="truncate">
                  {runs.find((run) => run.id === id)?.name}
                </li>
              ))}
            </ul>
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
                <Button
                  type="submit"
                  variant="primary"
                  disabled={!groupDraft?.trim() || groupSaving}
                >
                  {groupSaving ? 'Grouping…' : 'Make group'}
                </Button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={confirmRun !== null}
        onOpenChange={(open) => (open ? undefined : setConfirmActiveId(null))}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-6 shadow-elevated">
            <Dialog.Title className="text-base font-semibold tracking-tight text-foreground">
              Make “{confirmRun?.name}” the headline?
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-muted">
              {TELEGRAM_CONFIRM}
            </Dialog.Description>
            <p className="mt-2 text-xs text-muted">
              {currentActive
                ? `Headline now: ${currentActive.name}.`
                : 'There is no headline right now.'}
              {confirmRun && !isFollowed(confirmRun.status) ? ' It becomes Paper.' : ''}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirmActiveId(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  if (confirmRun) onSetActive(confirmRun.id);
                  setConfirmActiveId(null);
                }}
              >
                Confirm
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
