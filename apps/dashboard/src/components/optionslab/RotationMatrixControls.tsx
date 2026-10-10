'use client';

import {
  ANY,
  METRIC_NOTE,
  METRIC_OPTIONS,
  type MatrixFilters,
  VIEW_OPTIONS,
  WEEKDAYS,
  canCompare,
  needsStrategy,
  slotLabel,
} from '../../lib/rotationMatrixView';
import type { MatrixListId, MatrixMeta, MatrixPeriodId } from '../../types/rotationMatrix';
import { Card } from '../ui/Card';
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

const PERIOD_OPTIONS: SegmentedOption<MatrixPeriodId>[] = (
  ['P1', 'P2', 'P3', 'forward', 'custom'] as const
).map((value) => ({
  value,
  label: value === 'forward' ? 'Forward' : value === 'custom' ? 'Custom' : value,
}));

const LIST_OPTIONS: SegmentedOption<MatrixListId | typeof ANY>[] = [
  { value: ANY, label: 'None' },
  { value: 'A', label: 'A' },
  { value: 'B', label: 'B' },
  { value: 'C', label: 'C' },
  { value: 'REF', label: 'REF' },
];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 text-xs text-muted">
      {label}
      {children}
    </div>
  );
}

/**
 * The run bar of the matrix: which view, metric and period; which strategies and conditions;
 * which list's recorded picks to lay over it. Nothing here changes a registered list, and none
 * of it is a strategy parameter: they are display filters.
 */
export function RotationMatrixControls({
  filters: f,
  set,
  meta,
}: {
  filters: MatrixFilters;
  set: (patch: Partial<MatrixFilters>) => void;
  meta: MatrixMeta | undefined;
}) {
  const tags = Array.from(new Set((meta?.families ?? []).map((x) => x.family)));
  const compareOk = canCompare(f.view);
  const viewHint = VIEW_OPTIONS.find((o) => o.value === f.view)?.hint;
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
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl
            value={f.view}
            options={VIEW_OPTIONS.map(({ value, label }) => ({ value, label }))}
            onChange={(view) => set({ view })}
            ariaLabel="Matrix view"
            size="sm"
          />
          {viewHint ? <p className="text-xs text-muted">{viewHint}</p> : null}
        </div>
        <SegmentedControl
          value={f.metric}
          options={METRIC_OPTIONS.map((o) => ({
            ...o,
            disabled: o.value === 'selection' && f.list === ANY,
          }))}
          onChange={(metric) => set({ metric })}
          ariaLabel="Metric"
          size="sm"
        />
      </div>

      <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
        {f.view !== 'pulse' ? (
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
          <>
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
          </>
        ) : null}
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
      </div>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
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
            {(meta?.slots ?? []).map((s) => (
              <option key={s} value={s}>
                {slotLabel(s)}
              </option>
            ))}
          </Select>
        </Field>
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
        <Field label="Minimum sessions">
          <NumberField
            value={f.minN}
            min={1}
            max={1000}
            onChange={(minN) => set({ minN })}
            aria-label="Minimum sessions"
          />
        </Field>
      </div>
      <p className="text-xs text-muted">
        {METRIC_NOTE[f.metric]} Gross, per one lot, before costs. Alternative settings are not a
        portfolio: no row or column is summed.
        {f.list !== ANY
          ? ` The marks are list ${f.list}'s recorded picks, never reconstructed.`
          : ''}
      </p>
    </Card>
  );
}
