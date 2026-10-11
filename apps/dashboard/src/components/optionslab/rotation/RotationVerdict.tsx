/**
 * The registered comparisons for the focus list, in words: the difference per lot-day against REF
 * and against the fixed base with its 5-day block-bootstrap 90% interval, and whether the base's
 * pass rule is met. Under the minimum number of days the intervals are shown and the rule says so.
 */

import { formatInr } from '../../../lib/format';
import type { Verdict } from '../../../lib/rotationView';

function interval(l: { mean: number; lower: number; upper: number }): string {
  return `${formatInr(l.mean, { sign: true })} per lot-day, 90% interval ${formatInr(l.lower, { sign: true })} to ${formatInr(l.upper, { sign: true })}`;
}

export function RotationVerdict({ verdict }: { verdict: Verdict }) {
  if (verdict.lines.length === 0) return null;
  return (
    <section
      aria-label="Registered comparisons"
      className="space-y-1.5 rounded-lg border border-border bg-surface px-4 py-3 text-sm"
    >
      <h3 className="text-xs font-medium uppercase tracking-wider text-faint">
        The registered comparisons
      </h3>
      {verdict.lines.map((l) => (
        <p key={l.label} className="text-muted">
          <span className="font-medium text-foreground">{l.label}:</span> {interval(l)}
          {l.rule ? (
            <>
              {'. '}
              Drawdown per lot {l.rule.drawdownNoWorse ? 'no worse' : 'worse'}.{' '}
              <span
                className={
                  verdict.readable && l.rule.beats ? 'font-medium text-positive' : 'text-foreground'
                }
              >
                {!verdict.readable
                  ? 'Not readable yet: too few days for any list to pass.'
                  : l.rule.beats
                    ? 'Beats the base on the registered rule.'
                    : 'Does not beat the base on the registered rule.'}
              </span>
            </>
          ) : null}
        </p>
      ))}
      <p className="text-xs text-faint">
        {verdict.nDays} scored session{verdict.nDays === 1 ? '' : 's'}; the rule needs at least{' '}
        {verdict.minDays} to be read and is judged at the 60-session read-out.
      </p>
    </section>
  );
}
