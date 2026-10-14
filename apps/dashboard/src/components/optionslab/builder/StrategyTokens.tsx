'use client';

import { Plus } from 'lucide-react';
import { useState } from 'react';

import { formatInr } from '../../../lib/format';
import { UNDERLYINGS } from '../../../lib/legwiseBuilder';
import { OFF } from '../../../lib/legwiseGrid';
import type { LegwiseStrategy, Underlying } from '../../../types/legwise';
import { ChoiceCell, EditableCell } from './EditableCell';

type Slots = Record<string, string[]>;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "9:20" or "09:20" -> "09:20"; anything else is refused with a reason. */
export function parseTime(
  text: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  const value = m ? `${(m[1] ?? '').padStart(2, '0')}:${m[2]}` : '';
  return HHMM.test(value)
    ? { ok: true, value }
    : { ok: false, error: 'Use a time as HH:MM, for example 09:20.' };
}

/** "2500", "₹2,500" -> 2500; empty -> off; anything else is refused. */
export function parseRupees(
  text: string,
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  const t = text.trim().replace(/^₹\s*/, '').replace(/,/g, '').toLowerCase();
  if (t === '' || t === OFF || t === 'off' || t === 'none') return { ok: true, value: undefined };
  if (!/^\d+(\.\d+)?$/.test(t) || Number(t) <= 0) {
    return {
      ok: false,
      error: 'Use an amount in rupees above 0, or leave it empty to turn it off.',
    };
  }
  return { ok: true, value: Number(t) };
}

/** A non-negative number: slippage percent, cost per order. */
function parseNonNegative(
  text: string,
): { ok: true; value: number } | { ok: false; error: string } {
  const t = text.trim().replace(/^₹\s*/, '').replace(/%$/, '');
  if (t === '') return { ok: true, value: 0 };
  if (!/^\d+(\.\d+)?$/.test(t)) return { ok: false, error: 'Use a number, 0 or more.' };
  return { ok: true, value: Number(t) };
}

function Token({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-lg bg-surface-2/60 pl-2 pr-0.5">
      <span className="text-[11px] text-faint">{label}</span>
      <span className="min-w-[4.5rem]">{children}</span>
    </span>
  );
}

/**
 * The strategy's own settings as a row of tokens (BL-102 Phase 1c): index, entry and exit
 * times, the overall loss and profit, and what a leg stopping out does to the rest. Each is
 * edited in place. A setting that is off and optional (no new entries after, slippage, cost per
 * order) stays out of the row until "+ more" brings it in; once set it is always shown.
 */
export function StrategyTokens({
  strategy,
  slots,
  onChange,
}: {
  strategy: LegwiseStrategy;
  slots: Slots;
  onChange: (strategy: LegwiseStrategy) => void;
}) {
  const { overall, execution } = strategy;
  const hasNoReentry = Boolean(strategy.no_reentry_after);
  const hasCosts = execution.slippage_pct !== 0 || execution.cost_per_order_inr !== 0;
  const [more, setMore] = useState(false);
  const showMore = more || hasNoReentry || hasCosts;
  const set = (patch: Partial<LegwiseStrategy>) => onChange({ ...strategy, ...patch });

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Token label="Index">
        <ChoiceCell<Underlying>
          value={strategy.underlying}
          options={UNDERLYINGS.map((u) => ({ value: u, label: u }))}
          ariaLabel="Index"
          errors={slots.underlying}
          onChange={(underlying) => set({ underlying })}
        />
      </Token>
      <Token label="Enter">
        <EditableCell
          display={strategy.entry_time}
          ariaLabel="Entry time"
          mono
          errors={slots.entry_time}
          onCommit={(text) => {
            const t = parseTime(text);
            if (!t.ok) return t.error;
            set({ entry_time: t.value });
            return null;
          }}
        />
      </Token>
      <Token label="Exit">
        <EditableCell
          display={strategy.exit_time}
          ariaLabel="Exit time"
          mono
          errors={slots.exit_time}
          onCommit={(text) => {
            const t = parseTime(text);
            if (!t.ok) return t.error;
            set({ exit_time: t.value });
            return null;
          }}
        />
      </Token>
      <Token label="Max loss">
        <EditableCell
          display={overall.stop_loss_inr === undefined ? OFF : formatInr(overall.stop_loss_inr)}
          seed={overall.stop_loss_inr === undefined ? '' : String(overall.stop_loss_inr)}
          ariaLabel="Overall max loss in rupees"
          mono
          errors={slots['overall.stop_loss_inr']}
          placeholder="₹2,500"
          onCommit={(text) => {
            const r = parseRupees(text);
            if (!r.ok) return r.error;
            set({ overall: { ...overall, stop_loss_inr: r.value } });
            return null;
          }}
        />
      </Token>
      <Token label="Target">
        <EditableCell
          display={overall.target_inr === undefined ? OFF : formatInr(overall.target_inr)}
          seed={overall.target_inr === undefined ? '' : String(overall.target_inr)}
          ariaLabel="Overall max profit in rupees"
          mono
          errors={slots['overall.target_inr']}
          placeholder="₹5,000"
          onCommit={(text) => {
            const r = parseRupees(text);
            if (!r.ok) return r.error;
            set({ overall: { ...overall, target_inr: r.value } });
            return null;
          }}
        />
      </Token>
      <Token label="Leg stops">
        <ChoiceCell<LegwiseStrategy['square_off']>
          value={strategy.square_off}
          options={[
            { value: 'partial', label: 'exit that leg' },
            { value: 'complete', label: 'exit all legs' },
          ]}
          ariaLabel="When a leg stops out"
          errors={slots.square_off}
          onChange={(square_off) => set({ square_off })}
        />
      </Token>

      {showMore ? (
        <>
          <Token label="No new entry after">
            <EditableCell
              display={strategy.no_reentry_after || OFF}
              seed={strategy.no_reentry_after ?? ''}
              ariaLabel="No re-entry after"
              mono
              errors={slots.no_reentry_after}
              placeholder="13:00"
              onCommit={(text) => {
                if (text.trim() === '' || text.trim() === OFF) {
                  const { no_reentry_after: _drop, ...rest } = strategy;
                  onChange(rest);
                  return null;
                }
                const t = parseTime(text);
                if (!t.ok) return t.error;
                set({ no_reentry_after: t.value });
                return null;
              }}
            />
          </Token>
          <Token label="Slippage %">
            <EditableCell
              display={String(execution.slippage_pct)}
              ariaLabel="Slippage percent"
              mono
              errors={slots['execution.slippage_pct']}
              onCommit={(text) => {
                const r = parseNonNegative(text);
                if (!r.ok) return r.error;
                set({ execution: { ...execution, slippage_pct: r.value } });
                return null;
              }}
            />
          </Token>
          <Token label="Cost / order ₹">
            <EditableCell
              display={String(execution.cost_per_order_inr)}
              ariaLabel="Cost per order in rupees"
              mono
              errors={slots['execution.cost_per_order_inr']}
              onCommit={(text) => {
                const r = parseNonNegative(text);
                if (!r.ok) return r.error;
                set({ execution: { ...execution, cost_per_order_inr: r.value } });
                return null;
              }}
            />
          </Token>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setMore(true)}
          className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-muted hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="h-3 w-3" aria-hidden="true" />
          more: costs, last entry
        </button>
      )}
    </div>
  );
}
