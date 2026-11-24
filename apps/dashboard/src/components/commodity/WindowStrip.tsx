/** The sessions of one expiry window as chips: journaled, today, waiting for data, still to come. */

import { WINDOW_TONE } from '../../lib/commodityView';
import { formatDayShort } from '../../lib/format';
import type { ForwardWindow } from '../../types/commodity';
import { Badge } from '../ui/Badge';

export function WindowStrip({ window }: { window: ForwardWindow }) {
  return (
    <>
      <ul className="flex flex-wrap gap-2" aria-label="Sessions of the expiry window">
        {window.sessions.map((s) => (
          <li
            key={s.day}
            className="flex items-center gap-2 rounded-lg border border-border bg-surface-2/60 px-3 py-1.5"
          >
            <span className="metric text-sm text-foreground">
              {formatDayShort(s.day, { weekday: true })}
            </span>
            <Badge tone={WINDOW_TONE[s.state]}>{s.state}</Badge>
          </li>
        ))}
      </ul>
      {window.provisional ? (
        <p className="mt-2 text-xs text-muted">
          Provisional: a market holiday in the expiry week moves these dates one session earlier.
          They are fixed, and scored, on the expiry night.
        </p>
      ) : null}
    </>
  );
}
