'use client';

import type { ReactNode } from 'react';

import { VISIBLE_LIST_KEYS, listName } from '../../lib/rotationListNames';
import {
  ANY,
  type MatrixFilters,
  WEEKDAYS,
  canCompare,
  needsStrategy,
  slotLabel,
  slotListLabel,
} from '../../lib/rotationMatrixView';
import type { MatrixListId, MatrixMeta, MatrixPeriodId } from '../../types/rotationMatrix';
import { Input, NumberField, Select } from '../ui/Input';
import { SegmentedControl, type SegmentedOption } from '../ui/SegmentedControl';

const FAMILY_NAME: Record<string, string> = {
  wide: 'Widesl (OTM)',
  p80: 'Widesl, closest premium 80',
  p100: 'Widesl, closest premium 100',
  p250: 'Widesl, closest premium 250',
  p320: 'Widesl, closest premium 320',
  dir: 'Dir ATM',
  ditm1: 'Dir ITM1',
  buy: 'Buy',
};

/** The display name of a family filter value (`widesl`, `dirs`, a tag), for the run bar's summary. */
export function familyName(value: string): string {
  if (value === 'widesl') return 'Widesl (all)';
  if (value === 'dirs') return 'Dir (ATM and ITM1)';
  return FAMILY_NAME[value] ?? value;
}

const PERIOD_OPTIONS: SegmentedOption<MatrixPeriodId>[] = (
  ['P1', 'P2', 'P3', 'forward', 'custom'] as const
).map((value) => ({
  value,
  label: value === 'forward' ? 'Forward' : value === 'custom' ? 'Custom' : value,
}));

const LIST_OPTIONS: SegmentedOption<MatrixListId | typeof ANY>[] = [
  { value: ANY, label: 'None' },
  ...VISIBLE_LIST_KEYS.map((value) => ({ value, label: listName(value) })),
];

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 text-xs text-muted">
      {label}
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-faint">{title}</h3>
      {children}
    </section>
  );
}

/**
 * The matrix's settings, as the body of its settings drawer: which period; which strategies and
 * conditions; which list's recorded picks to lay over it. The view and metric toggles live on the
 * run bar. Nothing here changes a registered list, and none of it is a strategy parameter: they
 * are display filters.
 */
export function RotationMatrixControls({
  filters: f,
  set,
  meta,
  periodExtras,
}: {
  filters: MatrixFilters;
  set: (patch: Partial<MatrixFilters>) => void;
  meta: MatrixMeta | undefined;
  /** Shown at the top of the period section (the quick presets). */
  periodExtras?: ReactNode;
}) {
  const tags = Array.from(new Set((meta?.families ?? []).map((x) => x.family)));
  const compareOk = canCompare(f.view);
  const strategySelect = (
    <Field label="Strategy kind">
      <Select
        value={f.strategy}
        onChange={(e) => set({ strategy: e.target.value })}
        aria-label="Strategy kind"
      >
        {(meta?.families ?? [{ key: f.strategy, label: f.strategy }]).map((x) => (
          <option key={x.key} value={x.key}>
            {x.label}
          </option>
        ))}
      </Select>
    </Field>
  );
  return (
    <div className="space-y-6">
      <Section title={f.view === 'pulse' ? 'As of' : 'Period'}>
        {f.view !== 'pulse' ? (
          <>
            {periodExtras}
            <Field label="Period">
              <div className="flex flex-wrap items-center gap-2">
                <SegmentedControl
                  value={f.compare && compareOk ? ('P1' as MatrixPeriodId) : f.period}
                  options={PERIOD_OPTIONS.map((o) => ({
                    ...o,
                    disabled: f.compare && compareOk,
                  }))}
                  onChange={(period) => set({ period })}
                  ariaLabel="Period"
                  size="sm"
                />
                <SegmentedControl
                  value={f.compare && compareOk ? 'both' : 'one'}
                  options={[
                    { value: 'one', label: 'One period' },
                    { value: 'both', label: 'P1 and P2', disabled: !compareOk },
                  ]}
                  onChange={(v) => set({ compare: v === 'both' })}
                  ariaLabel="Compare periods"
                  size="sm"
                />
              </div>
            </Field>
          </>
        ) : (
          <Field label="As of">
            <Input
              type="date"
              value={f.to}
              onChange={(e) => set({ to: e.target.value })}
              aria-label="As of date"
              className="w-40"
            />
          </Field>
        )}
        {f.period === 'custom' && f.view !== 'pulse' && !f.compare ? (
          <div className="flex flex-wrap gap-3">
            <Field label="From">
              <Input
                type="date"
                value={f.from}
                onChange={(e) => set({ from: e.target.value })}
                aria-label="From date"
                className="w-40"
              />
            </Field>
            <Field label="To">
              <Input
                type="date"
                value={f.to}
                onChange={(e) => set({ to: e.target.value })}
                aria-label="To date"
                className="w-40"
              />
            </Field>
          </div>
        ) : null}
        <Field label="Minimum sessions">
          <NumberField
            value={f.minN}
            min={1}
            max={1000}
            onChange={(minN) => set({ minN })}
            aria-label="Minimum sessions"
            className="w-40"
          />
        </Field>
      </Section>

      <Section title="Which strategies">
        {needsStrategy(f.view) ? (
          strategySelect
        ) : (
          <Field label="Index">
            <SegmentedControl
              value={f.index}
              options={[
                { value: 'both', label: 'Both' },
                { value: 'NIFTY', label: 'NIFTY' },
                { value: 'SENSEX', label: 'SENSEX' },
              ]}
              onChange={(index) => set({ index })}
              ariaLabel="Index"
              size="sm"
            />
          </Field>
        )}
        {needsStrategy(f.view) ? null : (
          <Field label="Family">
            <Select
              value={f.family}
              onChange={(e) => set({ family: e.target.value })}
              aria-label="Family"
            >
              <option value={ANY}>All families</option>
              <option value="widesl">Widesl (all, incl. closest premium)</option>
              <option value="dirs">Dir (ATM and ITM1)</option>
              {tags.map((t) => (
                <option key={t} value={t}>
                  {FAMILY_NAME[t] ?? t}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Start time">
          <Select
            value={f.slot}
            onChange={(e) => set({ slot: e.target.value })}
            aria-label="Start time"
          >
            <option value={ANY}>Any start time</option>
            {f.slot.includes(',') ? (
              // a band opened from the Rotation page's Family pulse: several start times at once
              <option value={f.slot}>{slotListLabel(f.slot)}</option>
            ) : null}
            {(meta?.slots ?? []).map((s) => (
              <option key={s} value={s}>
                {slotLabel(s)}
              </option>
            ))}
          </Select>
        </Field>
      </Section>

      <Section title="Which days">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Weekday">
            <Select
              value={f.weekday}
              onChange={(e) => set({ weekday: e.target.value })}
              aria-label="Weekday"
            >
              <option value={ANY}>Any weekday</option>
              {WEEKDAYS.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Days to expiry (own index)">
            <Select
              value={f.dte}
              onChange={(e) => set({ dte: e.target.value })}
              aria-label="Days to expiry"
            >
              <option value={ANY}>Any</option>
              {(meta?.dte ?? []).map((x) => (
                <option key={x} value={x}>
                  {x === 'unknown' ? 'Unknown' : `${x} days`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Opening VIX band">
            <Select
              value={f.vix}
              onChange={(e) => set({ vix: e.target.value })}
              aria-label="VIX band"
            >
              <option value={ANY}>Any</option>
              {(meta?.vix_bands ?? []).map((x) => (
                <option key={x} value={x}>
                  {x === 'unknown' ? 'Unknown' : x}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Section>

      <Section title="Recorded picks">
        <Field label="Recorded picks of list">
          <SegmentedControl
            value={f.list}
            options={LIST_OPTIONS}
            onChange={(list) =>
              set({
                list,
                ...(list === ANY ? { basis: 'all' as const } : {}),
                ...(list === ANY && f.metric === 'selection' ? { metric: 'avg' as const } : {}),
              })
            }
            ariaLabel="List overlay"
            size="sm"
          />
        </Field>
        {f.list !== ANY && f.metric !== 'selection' ? (
          <Field label="Cells show">
            <SegmentedControl
              value={f.basis}
              options={[
                { value: 'all', label: 'All opportunities' },
                { value: 'selected', label: 'Selected only' },
              ]}
              onChange={(basis) => set({ basis })}
              ariaLabel="All opportunities or selected only"
              size="sm"
            />
          </Field>
        ) : null}
      </Section>
    </div>
  );
}
