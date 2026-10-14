'use client';

import { Copy, Link2, Link2Off, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';

import { cn } from '../../../lib/cn';
import type { PlacedIssues } from '../../../lib/legwiseBuilder';
import {
  amountCell,
  applyToLegs,
  pairedWith,
  parseAmount,
  parseReentry,
  parseStrike,
  parseTrail,
  reentryCell,
  strikeCell,
  trailCell,
} from '../../../lib/legwiseGrid';
import type { Leg } from '../../../types/legwise';
import { Button } from '../../ui/Button';
import { ChoiceCell, EditableCell } from './EditableCell';

const TYPES = [
  { value: 'CE', label: 'CE' },
  { value: 'PE', label: 'PE' },
] as const;

const EXPIRIES = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'next_weekly', label: 'Next weekly' },
  { value: 'monthly', label: 'Monthly' },
] as const;

/** A positive whole number of lots, as typed. */
function parseLots(text: string): { ok: true; value: number } | { ok: false; error: string } {
  const t = text.trim();
  if (!/^\d+$/.test(t) || Number(t) < 1) {
    return { ok: false, error: 'Lots is a whole number, 1 or more.' };
  }
  return { ok: true, value: Number(t) };
}

/**
 * The legs as a grid (BL-102 Phase 1c, design A): one dense row per leg, every cell edited in
 * place. A CE and a PE that match in everything else are a pair; while "Edit both legs together"
 * is on, an edit to one reaches the other (its side, lots, strike, stop, trail, target and
 * re-entry; never its id or type). Anything the grid does not show (a range breakout, a re-entry
 * on target, a breakout gap) is behind the leg's "All settings" button.
 */
export function LegGrid({
  legs,
  issues,
  together,
  onTogetherChange,
  onChange,
  onDetails,
  onCopy,
  onRemove,
  onAdd,
  onAddPair,
}: {
  legs: readonly Leg[];
  issues: PlacedIssues;
  together: boolean;
  onTogetherChange: (together: boolean) => void;
  onChange: (legs: Leg[]) => void;
  onDetails: (index: number) => void;
  onCopy: (index: number) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
  onAddPair: () => void;
}) {
  const errors = (index: number, field: string) => issues.bySlot[`legs.${index}.${field}`];
  const edit = (index: number, patch: Partial<Leg>) =>
    onChange(applyToLegs(legs, index, patch, together));
  const anyPair = legs.some((_, i) => pairedWith(legs, i) !== null);

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[46rem] table-fixed border-collapse text-xs">
          <colgroup>
            <col className="w-[5.5rem]" />
            <col className="w-[3.5rem]" />
            <col className="w-[4.5rem]" />
            <col className="w-[6.5rem]" />
            <col className="w-[5.5rem]" />
            <col className="w-[5.5rem]" />
            <col className="w-[6rem]" />
            <col className="w-[5rem]" />
            <col className="w-[5.5rem]" />
            <col className="w-[6.5rem]" />
          </colgroup>
          <thead>
            <tr className="border-b border-border text-left text-[11px] font-medium text-faint">
              <th className="px-1.5 py-1.5">Side</th>
              <th className="px-1.5 py-1.5">Lots</th>
              <th className="px-1.5 py-1.5">Type</th>
              <th className="px-1.5 py-1.5">Expiry</th>
              <th className="px-1.5 py-1.5">Strike</th>
              <th className="px-1.5 py-1.5">Stop</th>
              <th className="px-1.5 py-1.5">Trail</th>
              <th className="px-1.5 py-1.5">Target</th>
              <th className="px-1.5 py-1.5">Re-entry</th>
              <th className="px-1.5 py-1.5 text-right">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {legs.map((leg, i) => {
              const name = leg.id || `leg ${i + 1}`;
              const problems = issues.byLeg[i] ?? 0;
              const paired = pairedWith(legs, i) !== null;
              return (
                <tr key={`${leg.id}-${i}`} className="border-b border-border/60 last:border-0">
                  <td className="px-1.5 py-1">
                    <button
                      type="button"
                      aria-label={`Side for ${name}: ${leg.position}. Press to switch.`}
                      aria-invalid={(errors(i, 'position')?.length ?? 0) > 0 || undefined}
                      onClick={() =>
                        edit(i, { position: leg.position === 'sell' ? 'buy' : 'sell' })
                      }
                      className={cn(
                        'h-7 w-full rounded px-1.5 text-[11px] font-semibold uppercase tracking-wide focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        leg.position === 'sell'
                          ? 'bg-negative/10 text-negative hover:bg-negative/15'
                          : 'bg-positive/10 text-positive hover:bg-positive/15',
                      )}
                    >
                      {leg.position}
                    </button>
                  </td>
                  <td className="px-1.5 py-1">
                    <EditableCell
                      display={String(leg.lots)}
                      ariaLabel={`Lots for ${name}`}
                      mono
                      errors={errors(i, 'lots')}
                      onCommit={(text) => {
                        const parsed = parseLots(text);
                        if (!parsed.ok) return parsed.error;
                        edit(i, { lots: parsed.value });
                        return null;
                      }}
                    />
                  </td>
                  <td className="px-1.5 py-1">
                    <ChoiceCell
                      value={leg.option_type}
                      options={TYPES}
                      ariaLabel={`Type for ${name}`}
                      errors={errors(i, 'option_type')}
                      onChange={(option_type) => edit(i, { option_type })}
                    />
                  </td>
                  <td className="px-1.5 py-1">
                    <ChoiceCell
                      value={leg.expiry}
                      options={EXPIRIES}
                      ariaLabel={`Expiry for ${name}`}
                      errors={errors(i, 'expiry')}
                      onChange={(expiry) => edit(i, { expiry })}
                    />
                  </td>
                  <td className="px-1.5 py-1">
                    <EditableCell
                      display={strikeCell(leg.strike)}
                      ariaLabel={`Strike for ${name}`}
                      mono
                      errors={errors(i, 'strike')}
                      placeholder="ATM, OTM1, ₹65"
                      onCommit={(text) => {
                        const parsed = parseStrike(text);
                        if (!parsed.ok) return parsed.error;
                        edit(i, { strike: parsed.value });
                        return null;
                      }}
                    />
                  </td>
                  <td className="px-1.5 py-1">
                    <EditableCell
                      display={amountCell(leg.stop_loss)}
                      ariaLabel={`Stop for ${name}`}
                      mono
                      errors={errors(i, 'stop_loss')}
                      placeholder="25% or 10 pts"
                      onCommit={(text) => {
                        const parsed = parseAmount(text);
                        if (!parsed.ok) return parsed.error;
                        edit(i, { stop_loss: parsed.value });
                        return null;
                      }}
                    />
                  </td>
                  <td className="px-1.5 py-1">
                    <EditableCell
                      display={trailCell(leg.trail_sl)}
                      ariaLabel={`Trail for ${name}`}
                      mono
                      errors={errors(i, 'trail_sl')}
                      placeholder="15/10% or 1/1 pts"
                      onCommit={(text) => {
                        const parsed = parseTrail(text);
                        if (!parsed.ok) return parsed.error;
                        edit(i, { trail_sl: parsed.value });
                        return null;
                      }}
                    />
                  </td>
                  <td className="px-1.5 py-1">
                    <EditableCell
                      display={amountCell(leg.target)}
                      ariaLabel={`Target for ${name}`}
                      mono
                      errors={errors(i, 'target')}
                      placeholder="50% or 20 pts"
                      onCommit={(text) => {
                        const parsed = parseAmount(text);
                        if (!parsed.ok) return parsed.error;
                        edit(i, { target: parsed.value });
                        return null;
                      }}
                    />
                  </td>
                  <td className="px-1.5 py-1">
                    <EditableCell
                      display={reentryCell(leg.reentry_on_sl)}
                      ariaLabel={`Re-entry after a stop for ${name}`}
                      mono
                      errors={errors(i, 'reentry_on_sl')}
                      placeholder="now ×2 or at cost ×1"
                      onCommit={(text) => {
                        const parsed = parseReentry(text);
                        if (!parsed.ok) return parsed.error;
                        edit(i, { reentry_on_sl: parsed.value });
                        return null;
                      }}
                    />
                  </td>
                  <td className="px-1.5 py-1">
                    <div className="flex items-center justify-end gap-0.5">
                      {paired ? (
                        <span
                          title={
                            together
                              ? 'Paired with its CE/PE twin: edits go to both'
                              : 'Paired with its CE/PE twin'
                          }
                          className={cn('px-0.5', together ? 'text-primary' : 'text-faint')}
                        >
                          <Link2 className="h-3.5 w-3.5" aria-label="Paired" />
                        </span>
                      ) : null}
                      {leg.range_breakout ? (
                        <span
                          title={`Enters on a break of the ${leg.range_breakout.side} after ${leg.range_breakout.until}`}
                          className="rounded bg-surface-2 px-1 text-[10px] font-medium text-muted"
                        >
                          RB {leg.range_breakout.until}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        aria-label={`All settings for ${name}${problems ? `, ${problems} problem${problems === 1 ? '' : 's'}` : ''}`}
                        title="All settings: range breakout, re-entry on target, ids"
                        onClick={() => onDetails(i)}
                        className={cn(
                          'rounded p-1 text-muted hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          problems > 0 && 'text-negative',
                        )}
                      >
                        <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Copy ${name}`}
                        onClick={() => onCopy(i)}
                        className="rounded p-1 text-muted hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${name}`}
                        onClick={() => onRemove(i)}
                        className="rounded p-1 text-muted hover:bg-surface-2 hover:text-negative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {legs.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-3 py-4 text-center text-xs text-muted">
                  No legs yet. Add one below.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={onAdd}>
          <Plus className="h-3.5 w-3.5" />
          Add leg
        </Button>
        <Button size="sm" variant="secondary" onClick={onAddPair}>
          <Plus className="h-3.5 w-3.5" />
          Add CE + PE pair
        </Button>
        <span className="flex-1" />
        <label
          className={cn(
            'inline-flex items-center gap-1.5 text-xs',
            anyPair ? 'text-muted' : 'text-faint',
          )}
          title={
            anyPair
              ? 'A CE and a PE that match are edited together'
              : 'No CE + PE pair to edit together yet'
          }
        >
          <input
            type="checkbox"
            checked={together}
            disabled={!anyPair}
            onChange={(event) => onTogetherChange(event.target.checked)}
          />
          {together ? (
            <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Link2Off className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          Edit both legs together
        </label>
      </div>
    </div>
  );
}
