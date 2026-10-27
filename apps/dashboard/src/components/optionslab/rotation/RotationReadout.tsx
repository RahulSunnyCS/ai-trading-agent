/**
 * "Day 10 of 60 · 12 Oct → 27 Oct": where the forward test stands against its registered
 * read-out, as one chip on the page's run bar (it was a full-width banner until the dashboard
 * review of 2026-10-28). Until the read-out every figure on the page is descriptive; the tooltip
 * gives the rule the read-out is judged by.
 */

import { formatDay } from '../../../lib/format';
import { listName } from '../../../lib/rotationListNames';
import { LIST_KEYS, readoutProgress } from '../../../lib/rotationView';
import { InfoTooltip } from '../../ui/InfoTooltip';

const shown = LIST_KEYS.map(listName).join(', ');

export function RotationReadoutChip({
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
  firstEntryDay: string | null;
}) {
  const p = readoutProgress(scoredDays ?? 0, total);
  const started = (scoredDays ?? 0) > 0;
  const text =
    scoredDays === null
      ? 'Reading the read-out…'
      : started
        ? `Day ${p.n} of ${p.total}${firstDay && lastDay ? ` · ${formatDay(firstDay)} → ${formatDay(lastDay)}` : ''}`
        : firstEntryDay
          ? `Read-out starts ${formatDay(firstEntryDay)}`
          : 'Read-out not started';
  return (
    <span
      aria-label="Read-out progress"
      className="inline-flex items-center gap-2 rounded-full border border-info/30 bg-info/10 px-2.5 py-1 text-xs text-foreground"
    >
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
        <span className="block h-full bg-info" style={{ width: `${p.fraction * 100}%` }} />
      </span>
      {text}
      <InfoTooltip
        label="About the read-out"
        text={`${p.done ? 'The registered read-out can be scored now.' : 'Until the read-out every figure is descriptive and changes nothing.'} ${shown}: gross, max drawdown, and the share of random same-shape baskets it beats, with a 5-day block-bootstrap 90% interval of the list minus the fixed base. A list beats the base when that interval's lower bound is above zero and its drawdown per lot is no worse. The rule was registered before the first entry and does not change. The journal records every registered list under it, including those not shown here.`}
      />
    </span>
  );
}
