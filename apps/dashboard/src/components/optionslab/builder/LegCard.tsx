/**
 * One leg of the strategy: collapsed to a one-line summary, expanded to the full editor. The
 * validator's messages for the leg sit beside the field they are about.
 */

import { ChevronDown, ChevronRight, Copy, Trash2 } from 'lucide-react';

import { type PlacedIssues, STRIKE_TYPES, summarizeLeg } from '../../../lib/legwiseBuilder';
import type { Amount, Leg, ReEntry } from '../../../types/legwise';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { NumberField } from '../../ui/Input';
import {
  Choice,
  type Errors,
  FieldErrors,
  LabeledField,
  OptionalNumber,
  TextField,
} from './fields';

type Unit = 'off' | 'points' | 'percent';

const UNIT_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'points', label: 'Points' },
  { value: 'percent', label: '%' },
] as const;

const HINTS = {
  strike:
    'OTM1…OTM10 and ITM1…ITM3 count strike steps away from ATM, out of or into the money. Closest premium instead picks the strike whose premium at entry is nearest the number you enter.',
  trail:
    'Every time the premium moves X in the leg’s favour, the stop loss moves Y in the same direction.',
  reentry:
    'RE COST re-enters the same contract when its price comes back to the original entry price. RE ASAP picks the strike again by this leg’s rule and re-enters on the next minute.',
  rangeBreakout:
    'The leg waits: it records the high and low from entry until the range end, then enters only when that high or low is broken.',
} as const;

function AmountEditor(props: {
  label: string;
  value: Amount | undefined;
  onChange: (amount: Amount | undefined) => void;
  errors: Errors;
}) {
  const unit: Unit =
    props.value?.points !== undefined
      ? 'points'
      : props.value?.percent !== undefined
        ? 'percent'
        : 'off';
  const amount = props.value?.points ?? props.value?.percent;
  const set = (next: Unit, value: number | undefined) =>
    props.onChange(
      next === 'off'
        ? undefined
        : next === 'points'
          ? { points: value ?? 10 }
          : { percent: value ?? 25 },
    );
  return (
    <LabeledField label={props.label} errors={props.errors}>
      <div className="flex gap-1.5">
        <Choice<Unit>
          label={`${props.label} unit`}
          value={unit}
          options={UNIT_OPTIONS}
          onChange={(next) => set(next, amount)}
        />
        <OptionalNumber
          label={`${props.label} value`}
          value={amount}
          disabled={unit === 'off'}
          step={0.5}
          errors={props.errors}
          onChange={(value) => set(unit, value)}
        />
      </div>
    </LabeledField>
  );
}

function ReEntryEditor(props: {
  label: string;
  value: ReEntry | undefined;
  onChange: (reentry: ReEntry | undefined) => void;
  errors: Errors;
}) {
  const mode = props.value?.mode ?? 'off';
  return (
    <LabeledField label={props.label} hint={HINTS.reentry} errors={props.errors}>
      <div className="flex gap-1.5">
        <Choice<'off' | 'asap' | 'cost'>
          label={`${props.label} mode`}
          value={mode}
          errors={props.errors}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'cost', label: 'RE COST' },
            { value: 'asap', label: 'RE ASAP' },
          ]}
          onChange={(next) =>
            props.onChange(
              next === 'off' ? undefined : { mode: next, count: props.value?.count ?? 1 },
            )
          }
        />
        <OptionalNumber
          label={`${props.label} count`}
          value={props.value?.count}
          disabled={mode === 'off'}
          onChange={(count) => props.value && props.onChange({ ...props.value, count: count ?? 1 })}
          className="w-16"
        />
      </div>
    </LabeledField>
  );
}

export function LegCard(props: {
  leg: Leg;
  index: number;
  underlying: string;
  open: boolean;
  onToggle: () => void;
  onChange: (leg: Leg) => void;
  onRemove: () => void;
  onCopy: () => void;
  issues: PlacedIssues;
}) {
  const { leg, index, onChange, issues } = props;
  const set = <K extends keyof Leg>(key: K, value: Leg[K]) => onChange({ ...leg, [key]: value });
  const errors = (field: string): Errors => issues.bySlot[`legs.${index}.${field}`];
  const problemCount = issues.byLeg[index] ?? 0;
  const byPremium = leg.strike.closest_premium !== undefined;
  const trailUnit: Unit = leg.trail_sl?.points
    ? 'points'
    : leg.trail_sl?.percent
      ? 'percent'
      : 'off';
  const trail = leg.trail_sl?.points ?? leg.trail_sl?.percent;
  const setTrail = (unit: Unit, xy: [number, number] | undefined) =>
    set(
      'trail_sl',
      unit === 'off'
        ? undefined
        : unit === 'points'
          ? { points: xy ?? [10, 5] }
          : { percent: xy ?? [10, 5] },
    );
  const rb = leg.range_breakout;
  const panelId = `leg-panel-${index}`;

  return (
    <div className="rounded-lg border border-border bg-surface-2/30">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          aria-expanded={props.open}
          aria-controls={panelId}
          onClick={props.onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {props.open ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-faint" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-faint" aria-hidden="true" />
          )}
          <span className="shrink-0 text-xs font-semibold uppercase tracking-wider text-faint">
            {leg.id || `Leg ${index + 1}`}
          </span>
          <span className="min-w-0 truncate text-sm text-foreground">
            {summarizeLeg(leg, props.underlying)}
          </span>
        </button>
        {problemCount > 0 && (
          <Badge tone="negative" className="shrink-0">
            {problemCount === 1 ? '1 problem' : `${problemCount} problems`}
          </Badge>
        )}
        <Button size="icon" variant="ghost" onClick={props.onCopy} aria-label="Copy leg">
          <Copy className="h-3.5 w-3.5" />
        </Button>
        <Button size="icon" variant="ghost" onClick={props.onRemove} aria-label="Remove leg">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {props.open && (
        <div id={panelId} className="space-y-3 border-t border-border px-4 py-4">
          <FieldErrors errors={issues.bySlot[`legs.${index}`]} />
          <div className="flex flex-wrap items-start gap-3">
            <LabeledField label="Id" errors={errors('id')}>
              <TextField
                label="Leg id"
                value={leg.id}
                onChange={(value) => set('id', value)}
                className="w-24"
                errors={errors('id')}
              />
            </LabeledField>
            <LabeledField label="Lots" errors={errors('lots')}>
              <NumberField
                value={leg.lots}
                min={1}
                step={1}
                aria-label="Lots"
                className="w-16"
                onChange={(value) => set('lots', value)}
              />
            </LabeledField>
            <LabeledField label="Position" errors={errors('position')}>
              <Choice
                label="Position"
                value={leg.position}
                options={[
                  { value: 'sell', label: 'Sell' },
                  { value: 'buy', label: 'Buy' },
                ]}
                onChange={(value) => set('position', value)}
              />
            </LabeledField>
            <LabeledField label="Option" errors={errors('option_type')}>
              <Choice
                label="Option type"
                value={leg.option_type}
                options={['CE', 'PE'] as const}
                onChange={(value) => set('option_type', value)}
              />
            </LabeledField>
            <LabeledField label="Expiry" errors={errors('expiry')}>
              <Choice
                label="Expiry"
                value={leg.expiry}
                options={[
                  { value: 'weekly', label: 'Weekly' },
                  { value: 'next_weekly', label: 'Next weekly' },
                  { value: 'monthly', label: 'Monthly' },
                ]}
                onChange={(value) => set('expiry', value)}
              />
            </LabeledField>
            <LabeledField label="Strike" hint={HINTS.strike} errors={errors('strike')}>
              <div className="flex gap-1.5">
                <Choice<'type' | 'premium'>
                  label="Strike selection"
                  value={byPremium ? 'premium' : 'type'}
                  options={[
                    { value: 'type', label: 'Strike type' },
                    { value: 'premium', label: 'Closest premium' },
                  ]}
                  onChange={(mode) =>
                    set(
                      'strike',
                      mode === 'premium' ? { closest_premium: 50 } : { strike_type: 'ATM' },
                    )
                  }
                />
                {byPremium ? (
                  <OptionalNumber
                    label="Premium"
                    value={leg.strike.closest_premium}
                    errors={errors('strike')}
                    onChange={(value) => set('strike', { closest_premium: value ?? 50 })}
                  />
                ) : (
                  <Choice<string>
                    label="Strike type"
                    value={leg.strike.strike_type ?? 'ATM'}
                    errors={errors('strike')}
                    // A loaded file may use a step the menu does not list (OTM12): keep it.
                    options={
                      (STRIKE_TYPES as readonly string[]).includes(leg.strike.strike_type ?? 'ATM')
                        ? STRIKE_TYPES
                        : [...STRIKE_TYPES, leg.strike.strike_type ?? 'ATM']
                    }
                    onChange={(value) => set('strike', { strike_type: value })}
                  />
                )}
              </div>
            </LabeledField>
          </div>

          <div className="flex flex-wrap items-start gap-3">
            <AmountEditor
              label="Stop loss"
              value={leg.stop_loss}
              errors={errors('stop_loss')}
              onChange={(amount) => set('stop_loss', amount)}
            />
            <AmountEditor
              label="Target"
              value={leg.target}
              errors={errors('target')}
              onChange={(amount) => set('target', amount)}
            />
            <LabeledField
              label="Trail SL (every X move SL by Y)"
              hint={HINTS.trail}
              errors={errors('trail_sl')}
            >
              <div className="flex gap-1.5">
                <Choice<Unit>
                  label="Trail SL unit"
                  value={trailUnit}
                  errors={errors('trail_sl')}
                  options={UNIT_OPTIONS}
                  onChange={(unit) => setTrail(unit, trail)}
                />
                <OptionalNumber
                  label="Trail SL: every X"
                  value={trail?.[0]}
                  disabled={trailUnit === 'off'}
                  onChange={(x) => setTrail(trailUnit, [x ?? 1, trail?.[1] ?? 1])}
                  className="w-16"
                />
                <OptionalNumber
                  label="Trail SL: move SL by Y"
                  value={trail?.[1]}
                  disabled={trailUnit === 'off'}
                  onChange={(y) => setTrail(trailUnit, [trail?.[0] ?? 1, y ?? 1])}
                  className="w-16"
                />
              </div>
            </LabeledField>
            <ReEntryEditor
              label="Re-entry on SL"
              value={leg.reentry_on_sl}
              errors={errors('reentry_on_sl')}
              onChange={(reentry) => set('reentry_on_sl', reentry)}
            />
            <ReEntryEditor
              label="Re-entry on target"
              value={leg.reentry_on_target}
              errors={errors('reentry_on_target')}
              onChange={(reentry) => set('reentry_on_target', reentry)}
            />
          </div>

          <div className="flex flex-wrap items-start gap-3">
            <LabeledField
              label="Range breakout"
              hint={HINTS.rangeBreakout}
              errors={errors('range_breakout')}
            >
              <label className="flex h-8 items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={rb !== undefined}
                  onChange={(event) =>
                    set(
                      'range_breakout',
                      event.target.checked
                        ? { until: '09:45', side: 'high', source: 'instrument' }
                        : undefined,
                    )
                  }
                />
                Wait for a breakout
              </label>
            </LabeledField>
            {rb && (
              <>
                <LabeledField label="Range until">
                  <TextField
                    label="Range until"
                    type="time"
                    value={rb.until}
                    errors={errors('range_breakout')}
                    onChange={(value) => set('range_breakout', { ...rb, until: value })}
                  />
                </LabeledField>
                <LabeledField label="Break of">
                  <Choice
                    label="Break of"
                    value={rb.side}
                    options={[
                      { value: 'high', label: 'High' },
                      { value: 'low', label: 'Low' },
                    ]}
                    onChange={(value) => set('range_breakout', { ...rb, side: value })}
                  />
                </LabeledField>
                <LabeledField label="Range on">
                  <Choice
                    label="Range on"
                    value={rb.source}
                    options={[
                      { value: 'instrument', label: 'Option premium' },
                      { value: 'underlying', label: 'Index' },
                    ]}
                    onChange={(value) => set('range_breakout', { ...rb, source: value })}
                  />
                </LabeledField>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
