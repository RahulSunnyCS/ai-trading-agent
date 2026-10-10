/**
 * Under a rotation variant's replay: does the replayed gross equal the one the nightly update
 * stored? A difference means the day's data was repaired after the update, or the strategy file
 * was edited since; the number next to it in the log is then not what this chart shows.
 */

import { replayStatus } from '../../lib/rotationDailyLogView';
import type { RotationReplay } from '../../types/legwise';

export function RotationReplayStatus({ r }: { r: RotationReplay }) {
  const s = replayStatus(r);
  if (s.matches) return <p className="mt-1 text-xs text-muted">{s.text}</p>;
  return (
    <output className="mt-2 block rounded-md border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-xs text-foreground">
      {s.text}
    </output>
  );
}
