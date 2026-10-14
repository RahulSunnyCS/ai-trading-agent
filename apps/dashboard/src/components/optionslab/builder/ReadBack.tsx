import { CheckCircle2, CircleAlert } from 'lucide-react';

import { cn } from '../../../lib/cn';
import { readBack } from '../../../lib/legwiseGrid';
import type { LegwiseStrategy } from '../../../types/legwise';

/**
 * "In plain words" (BL-102 Phase 1c): the strategy read back as a few sentences, beside whether
 * it is ready to run. The sentences are built from the form's own state, so they can never
 * describe something the strategy does not do.
 */
export function ReadBack({
  strategy,
  problems,
  checking,
}: {
  strategy: LegwiseStrategy;
  /** One plain sentence per problem the validator found; empty when it found none. */
  problems: readonly string[];
  /**
   * True while the validator has not answered for the current edit, or could not be reached:
   * "Ready to run" is only said when it has answered and found nothing, so the parent must pass
   * `checking` for any state in which it has no answer.
   */
  checking: boolean;
}) {
  const ready = problems.length === 0 && !checking;
  return (
    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_16rem]">
      <section aria-label="In plain words" className="rounded-lg bg-surface-2/50 px-3 py-2.5">
        <h3 className="text-xs font-semibold text-foreground">In plain words</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted">{readBack(strategy)}</p>
      </section>
      <section
        aria-label={problems.length > 0 ? 'What to fix' : 'Ready to run'}
        aria-live="polite"
        className={cn(
          'rounded-lg border px-3 py-2.5 text-xs',
          problems.length > 0 ? 'border-negative/40' : 'border-border',
        )}
      >
        {problems.length > 0 ? (
          <>
            <p className="flex items-center gap-1.5 font-medium text-negative">
              <CircleAlert className="h-3.5 w-3.5" aria-hidden="true" />
              {problems.length === 1 ? '1 thing to fix' : `${problems.length} things to fix`}
            </p>
            <ul className="mt-1 space-y-0.5 text-muted">
              {problems.slice(0, 5).map((p, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: two legs can share a message
                <li key={`${i}-${p}`}>{p}</li>
              ))}
              {problems.length > 5 ? <li>…and {problems.length - 5} more.</li> : null}
            </ul>
          </>
        ) : (
          <p
            className={cn(
              'flex items-center gap-1.5 font-medium',
              ready ? 'text-positive' : 'text-muted',
            )}
          >
            {ready ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> : null}
            {ready ? 'Ready to run' : 'Checking…'}
          </p>
        )}
      </section>
    </div>
  );
}
