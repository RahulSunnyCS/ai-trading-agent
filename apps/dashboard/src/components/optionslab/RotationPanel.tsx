/**
 * Options Lab → Rotation: how the four registered lists (A, B, C, REF) are doing on days nobody
 * had seen, against REF, the owner's fixed base and random baskets, and whether today's data can
 * be trusted (BL-058 Phase 4).
 *
 * The first screen (health strip, read-out banner, headline, hero chart) answers "is this good?"
 * from two small requests. Widgets below it load after the chart paints.
 *
 * Gross only: the stored costs are zero. Lists are alternative baskets and are never added up.
 * Nothing on this page changes a list, a weight or the journal.
 */

import { useMemo, useState } from 'react';

import { useRotationOverview, useRotationSummary } from '../../hooks/useRotation';
import {
  BENCHMARK_LABEL,
  BENCHMARK_NOTE,
  LIST_KEYS,
  type RotationBenchmark,
  benchmarkFigures,
  headline,
  heroSeries,
} from '../../lib/rotationView';
import type { RotationListKey } from '../../types/rotation';
import { Card, CardHeader } from '../ui/Card';
import { RefreshButton } from '../ui/RefreshButton';
import { SegmentedControl, type SegmentedOption } from '../ui/SegmentedControl';
import { SkeletonRows } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';
import { RotationBaskets } from './rotation/RotationBaskets';
import { RotationHeadline } from './rotation/RotationHeadline';
import { RotationHealthStrip } from './rotation/RotationHealth';
import { RotationHero } from './rotation/RotationHero';
import { RotationReadoutBanner } from './rotation/RotationReadout';

const FOCUS_OPTIONS: SegmentedOption<RotationListKey>[] = LIST_KEYS.map((value) => ({
  value,
  label: value,
}));

const BENCHMARK_OPTIONS: SegmentedOption<RotationBenchmark>[] = (
  ['REF', 'base', 'random'] as const
).map((value) => ({ value, label: BENCHMARK_LABEL[value] }));

export function RotationPanel() {
  const overview = useRotationOverview();
  const summary = useRotationSummary();
  const [focus, setFocus] = useState<RotationListKey>('A');
  const [benchmark, setBenchmark] = useState<RotationBenchmark>('REF');
  const [shown, setShown] = useState<ReadonlySet<RotationListKey>>(new Set(['A', 'REF']));
  const [showBase, setShowBase] = useState(true);

  const readoutDays = overview.data?.readout_days ?? 60;
  const s = summary.data;

  const visible = useMemo(() => new Set<RotationListKey>([...shown, focus]), [shown, focus]);
  const figures = useMemo(
    () => (s ? headline(s, focus, benchmark, readoutDays) : []),
    [s, focus, benchmark, readoutDays],
  );
  const points = useMemo(() => (s ? heroSeries(s, focus) : []), [s, focus]);
  const bench = s ? benchmarkFigures(s, benchmark, focus) : null;

  const reload = () => {
    overview.refetch();
    summary.refetch();
  };
  const toggle = (k: RotationListKey) =>
    setShown((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2 text-xs text-muted">
          Focus
          <SegmentedControl
            value={focus}
            options={FOCUS_OPTIONS}
            onChange={setFocus}
            ariaLabel="Focus list"
            size="sm"
          />
        </div>
        <div className="flex items-center gap-2 text-xs text-muted">
          Compare with
          <SegmentedControl
            value={benchmark}
            options={BENCHMARK_OPTIONS}
            onChange={setBenchmark}
            ariaLabel="Benchmark"
            size="sm"
          />
        </div>
        <span className="rounded-full border border-border px-2.5 py-1 text-xs text-muted">
          Forward · gross · 2 lots per strategy
        </span>
        <span className="flex-1" />
        <RefreshButton
          onClick={reload}
          loading={overview.loading || summary.loading}
          label="Reload"
        />
      </div>
      <p className="text-xs text-faint">{BENCHMARK_NOTE[benchmark]}</p>

      {overview.error && !overview.data ? (
        <StateMessage
          variant="error"
          title="Could not read the rotation journal"
          description={overview.error}
        />
      ) : overview.data ? (
        <>
          <RotationHealthStrip health={overview.data.health} />
          <RotationReadoutBanner
            scoredDays={s?.n_days ?? 0}
            total={readoutDays}
            firstDay={s?.first_day ?? null}
            lastDay={s?.last_day ?? null}
            firstEntryDay={overview.data.first_entry_day}
          />
        </>
      ) : (
        <SkeletonRows rows={2} />
      )}

      {summary.error && !s ? (
        <StateMessage
          variant="error"
          title="Could not compute the read-out"
          description={summary.error}
        />
      ) : s === null ? (
        <SkeletonRows rows={5} />
      ) : (
        <>
          <RotationHeadline figures={figures} benchmarkLabel={bench?.label ?? ''} />
          <Card>
            <CardHeader
              title="Cumulative gross by list"
              description={
                s.n_days === 0
                  ? 'Appears with the first scored session.'
                  : `${s.n_days} scored forward sessions, 2 lots per strategy. Late entries and unscored days are left out.`
              }
            />
            {s.n_days === 0 ? (
              <StateMessage
                variant="empty"
                title="No scored forward sessions yet"
                description={
                  Object.values(s.pending_reasons)[0] ??
                  'The first entry is recorded at 09:16 and scored by the 19:45 update the same evening.'
                }
              />
            ) : (
              <RotationHero
                points={points}
                focus={focus}
                shown={visible}
                onToggle={toggle}
                showBase={showBase}
                onToggleBase={() => setShowBase((v) => !v)}
              />
            )}
            {s.n_days > 0 && Object.keys(s.pending_reasons).length > 0 ? (
              <ul className="mt-3 space-y-0.5 text-xs text-muted">
                {Object.entries(s.pending_reasons).map(([day, why]) => (
                  <li key={day}>
                    <span className="font-mono">{day}</span> waiting: {why}
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>
        </>
      )}

      {overview.data ? (
        <Card>
          <CardHeader
            title="Today's baskets"
            description="What each list holds, why it holds it, and what changed since yesterday."
          />
          <RotationBaskets
            baskets={overview.data.baskets}
            specs={overview.data.lists}
            firstEntryDay={overview.data.first_entry_day}
          />
        </Card>
      ) : null}

      {/* ---- widget slots: one line each, in page order; other rotation widgets mount here ---- */}
      {/* slot:explain */}
      {/* slot:daily-log */}
      {/* slot:shadow */}
    </div>
  );
}
