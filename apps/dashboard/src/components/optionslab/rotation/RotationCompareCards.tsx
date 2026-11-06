/**
 * The two cards under the Books table (dashboard review, 2026-11-05): the head-to-head with the
 * fixed base for the picked window, and the drift alarm on the 60-session gap. Figures are
 * `GET /legwise/rotation/beats/compare`'s via `lib/rotationCompare.ts`; nothing is recomputed. A
 * range that includes zero is said so, and what the history is made of is said under the cards.
 */

import { cn } from '../../../lib/cn';
import { EMPTY, formatDay, formatInr, formatPct } from '../../../lib/format';
import {
  ALARM_WORDS,
  type CompareRead,
  alarmLine,
  liveShare,
  rangeText,
  sigmaText,
  windowSubtitle,
} from '../../../lib/rotationCompare';
import type { CompareBook, CompareWindow } from '../../../types/rotationCompare';
import { Badge } from '../../ui/Badge';
import { pnlClass } from '../shared';

const NAMES: Record<CompareBook, string> = {
  t1: 'Adaptive Tuned',
  core: 'Adaptive Classic',
  base: 'Fixed base',
};

function Kpi({
  label,
  value,
  valueClass,
  sub,
}: {
  label: string;
  value: string;
  valueClass?: string | undefined;
  sub?: string | undefined;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface-2/40 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={cn('mt-0.5 font-mono text-lg tabular-nums', valueClass)}>{value}</div>
      {sub ? <div className="font-mono text-[11px] text-faint">{sub}</div> : null}
    </div>
  );
}

export function RotationCompareCards({
  read,
  window,
}: { read: CompareRead; window: CompareWindow }) {
  const data = read.data;
  if (!data) {
    return (
      <div className="border-t border-border px-4 py-3 text-xs text-muted" aria-live="polite">
        {read.error
          ? `The head-to-head could not be read: ${read.error}`
          : 'Reading the head-to-head with the fixed base…'}
      </div>
    );
  }
  const row = data.windows[window];
  const subtitle = windowSubtitle(data, window);
  return (
    <>
      <div className="border-t border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">Against the fixed base</h3>
        <p className="mb-2 text-xs text-muted">
          {subtitle ?? 'No sessions in this window.'} Head-to-head on the same days, ₹ per lot-day,
          with a 90% block-bootstrap range. A range that includes zero means not distinguishable
          from the base.
        </p>
        {row ? (
          <div className="grid gap-2 sm:grid-cols-3">
            {(['t1', 'core'] as const).map((b) => {
              const f = row.books[b];
              const r = rangeText(f);
              return (
                <Kpi
                  key={b}
                  label={`${NAMES[b]} minus base`}
                  value={f.gap_mean === undefined ? EMPTY : formatInr(f.gap_mean, { sign: true })}
                  valueClass={f.gap_mean === undefined ? undefined : pnlClass(f.gap_mean)}
                  sub={
                    r
                      ? `${r.text} · ${r.includesZero ? 'includes 0' : 'clears 0'}${
                          f.better_days_pct === undefined
                            ? ''
                            : ` · ahead on ${formatPct(f.better_days_pct, 0, { unit: 'percent' })} of days`
                        }`
                      : undefined
                  }
                />
              );
            })}
            <Kpi
              label="Fixed base, edge over random"
              value={sigmaText(row.books.base) ?? EMPTY}
              sub="the yardstick: one rule every day"
            />
          </div>
        ) : null}
        {row ? (
          <p className="mt-2 rounded-lg bg-surface-2/40 px-3 py-2 text-xs text-muted">
            {liveShare(row)} Adaptive Tuned's settings were chosen on this history, so its gap is
            flattering. The registered verdict below is the live test.
          </p>
        ) : null}
      </div>
      <div className="border-t border-border px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">
          Drift alarm · last {data.alarm.window} sessions
        </h3>
        <p className="mb-2 text-xs text-muted">{alarmLine(data.alarm.below, data.alarm.window)}</p>
        <div className="grid gap-2 sm:grid-cols-3">
          {(['t1', 'core'] as const).map((b) => {
            const a = data.alarm.books[b];
            if (!a) return <Kpi key={b} label={NAMES[b]} value={EMPTY} sub="too few sessions" />;
            const w = ALARM_WORDS[a.state];
            return (
              <div key={b} className="rounded-lg border border-border bg-surface-2/40 px-3 py-2">
                <div className="text-[11px] uppercase tracking-wide text-muted">{NAMES[b]}</div>
                <div className={cn('mt-0.5 font-mono text-lg tabular-nums', pnlClass(a.gap))}>
                  {formatInr(a.gap, { sign: true })}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-faint">
                  <Badge tone={w.tone}>{w.label}</Badge>
                  <span>
                    {a.last_review_day
                      ? `last review ${formatDay(a.last_review_day)}`
                      : 'never in the record'}
                  </span>
                </div>
              </div>
            );
          })}
          <Kpi label="Where it is checked" value="on this page" sub="no Telegram alert yet" />
        </div>
      </div>
    </>
  );
}
