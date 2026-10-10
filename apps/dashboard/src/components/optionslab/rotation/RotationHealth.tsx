/**
 * The data-health strip: one line of checks that says whether today's numbers can be trusted.
 * A problem expands into a sentence that names its fix (the server writes the sentence).
 */

import { formatIstTime } from '../../../lib/format';
import type { RotationCheck, RotationCheckState, RotationHealth } from '../../../types/rotation';

const DOT: Record<RotationCheckState, string> = {
  ok: 'bg-positive',
  info: 'bg-info',
  warn: 'bg-warning',
  bad: 'bg-negative',
};

const STATE_WORD: Record<RotationCheckState, string> = {
  ok: 'OK',
  info: 'Info',
  warn: 'Needs attention',
  bad: 'Problem',
};

function Chip({ check }: { check: RotationCheck }) {
  return (
    <li className="flex items-center gap-1.5 whitespace-nowrap" title={check.detail || undefined}>
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${DOT[check.state]}`}
        role="img"
        aria-label={STATE_WORD[check.state]}
      />
      <span className="text-faint">{check.label}</span>
      <span className="font-mono text-foreground">{check.value}</span>
    </li>
  );
}

export function RotationHealthStrip({ health }: { health: RotationHealth }) {
  const problems = health.checks.filter((c) => c.detail && c.state !== 'ok' && c.state !== 'info');
  return (
    <section
      aria-label="Data health"
      className="rounded-lg border border-border bg-surface px-3 py-2 text-xs"
    >
      <ul className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
        {health.checks.map((c) => (
          <Chip key={c.id} check={c} />
        ))}
        <li className="ml-auto whitespace-nowrap text-faint">
          checked {formatIstTime(health.as_of)} IST
        </li>
      </ul>
      {problems.length > 0 ? (
        <ul className="mt-2 space-y-1 border-t border-border pt-2">
          {problems.map((c) => (
            <li key={c.id} className={c.state === 'bad' ? 'text-negative' : 'text-warning'}>
              <span className="font-medium">{c.label}:</span> {c.detail}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
