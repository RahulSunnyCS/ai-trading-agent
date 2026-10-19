/**
 * "Without the portfolio stop" under a Rotation card's stop button (owner, 2026-10-19): what the
 * card's own stop changed on the latest scored day and since the first, from the same
 * `/portfolio/days` rows the card's stopped figures come from. The lines are
 * `lib/rotationPortfolioView.ts::stopEffectRows`; nothing is computed here.
 */

import { type StopEffect, stopEffectRows } from '../../../lib/rotationPortfolioView';

export function StopEffectBlock({ effect }: { effect: StopEffect }) {
  return (
    <section aria-label="Without the portfolio stop" className="space-y-0.5">
      <div className="text-[11px] font-medium text-muted">Without the portfolio stop</div>
      <dl className="space-y-0.5">
        {stopEffectRows(effect).map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-3 text-[11px]">
            <dt className="shrink-0 text-faint">{r.label}</dt>
            <dd className="metric text-right text-foreground">{r.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
