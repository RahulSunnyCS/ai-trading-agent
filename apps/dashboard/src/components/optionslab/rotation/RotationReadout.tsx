/**
 * "Day 18 of 60": where the forward test stands against its registered read-out, and the rule
 * that read-out will be judged by. Until then every figure on the page is descriptive.
 */

import { formatDay } from '../../../lib/format';
import { readoutProgress } from '../../../lib/rotationView';
import { InfoTooltip } from '../../ui/InfoTooltip';

export function RotationReadoutBanner({
  scoredDays,
  total,
  firstDay,
  lastDay,
  firstEntryDay,
}: {
  scoredDays: number | null;
  total: number;
  firstDay: string | null;
  lastDay: string | null;
  firstEntryDay: string;
}) {
  const p = readoutProgress(scoredDays ?? 0, total);
  const loading = scoredDays === null;
  const started = (scoredDays ?? 0) > 0;
  return (
    <section
      aria-label="Read-out progress"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-xs"
    >
      <span className="font-medium text-foreground">
        {loading
          ? 'Reading the read-out…'
          : started
            ? `Day ${p.n} of ${p.total}`
            : `Starts ${formatDay(firstEntryDay)}`}
      </span>
      <div
        className="h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-surface-2"
        aria-hidden="true"
      >
        <div className="h-full bg-info" style={{ width: `${p.fraction * 100}%` }} />
      </div>
      <span className="text-muted">
        {p.done
          ? 'The registered read-out can be scored now.'
          : 'Until the read-out every figure is descriptive and changes nothing.'}
        {started && firstDay && lastDay ? ` ${formatDay(firstDay)} to ${formatDay(lastDay)}.` : ''}
      </span>
      <InfoTooltip
        label="About the read-out"
        text="Per list: gross, max drawdown, and the share of random same-shape baskets it beats, with REF as the comparator and a 5-day block-bootstrap 90% interval of each list minus REF and minus the fixed base. A list beats the base when that interval's lower bound is above zero and its drawdown per lot is no worse. The rule was registered before the first entry and does not change."
      />
    </section>
  );
}
