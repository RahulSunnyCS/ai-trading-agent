/**
 * The Today page's baskets with what the platforms hold (dashboard review, 2026-10-28):
 * `PlanPickLine` is the line under a recorded pick (its settings and its state on each account
 * that uploads its book); `RotationTomorrow` is the next session's tentative list (the 16:00
 * message's), each pick with the same line, so the evening's uploads can be checked here.
 * Read through `/legwise/rotation/plan`; nothing here computes a figure.
 */

import { formatDay } from '../../../lib/format';
import { extraLines, pickChips, sessionOf, settingsOf } from '../../../lib/rotationPlanView';
import type { PlanBook, PlanSession, RotationPlan } from '../../../types/rotationPlan';
import { Badge } from '../../ui/Badge';

export function PlanPickLine({
  plan,
  session,
  book,
  name,
}: {
  plan: RotationPlan;
  session: PlanSession;
  book: PlanBook;
  name: string;
}) {
  const pick = settingsOf(session, book, name);
  const chips = pickChips(plan, book, session.day, name, session.kind);
  if (!pick && chips.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
      {pick?.params ? <span className="font-mono text-faint">{pick.params}</span> : null}
      {chips.map((c) => (
        <span key={c.account} title={c.title}>
          <Badge tone={c.tone} className="px-1.5 py-0 text-[10px]">
            {c.account} · {c.text}
          </Badge>
        </span>
      ))}
    </span>
  );
}

const BOOK_TITLE: Record<PlanBook, string> = { core: 'Adaptive Classic', t1: 'Adaptive Tuned' };

export function RotationTomorrow({ plan }: { plan: RotationPlan }) {
  const s = sessionOf(plan, 'tentative');
  if (!s) return null;
  const books = (['core', 't1'] as const).filter((b) => (s.books[b]?.length ?? 0) > 0);
  return (
    <section aria-label="Next session, tentative" className="space-y-2 border-t border-border pt-3">
      <p className="flex flex-wrap items-baseline gap-x-3 text-xs text-muted">
        <span className="font-medium text-foreground">{formatDay(s.day)} · tentative</span>
        <span>
          The list the 16:00 message sent{s.sent_on ? ` on ${formatDay(s.sent_on)}` : ''}, from the
          evening's VIX close; the 09:16 entry confirms or changes it, and the morning top-up
          uploads any change.
        </span>
      </p>
      {plan.paused_until ? (
        <p className="text-xs text-warning">
          Automation is paused until {formatDay(plan.paused_until)}: nothing is uploaded or switched
          on.
        </p>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {books.map((book) => (
          <div key={book} className="rounded-lg border border-border bg-surface px-3 py-2">
            <div className="mb-1 text-sm font-semibold text-foreground">{BOOK_TITLE[book]}</div>
            <ul>
              {(s.books[book] ?? []).map((p) => (
                <li key={p.name} className="rounded px-1 text-xs">
                  <div className="flex h-7 items-center gap-2">
                    <span className="w-10 shrink-0 font-mono text-faint">{p.start ?? ''}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-foreground">
                      {p.name}
                    </span>
                    {p.role === 'buy' ? <span className="text-[10px] text-faint">Buy</span> : null}
                  </div>
                  <div className="pb-1 pl-12">
                    <PlanPickLine plan={plan} session={s} book={book} name={p.name} />
                  </div>
                </li>
              ))}
            </ul>
            {extraLines(plan, book, s.day).map((line) => (
              <p key={line} className="mt-1 text-[11px] text-muted">
                {line}
              </p>
            ))}
          </div>
        ))}
      </div>
      {plan.accounts.length === 0 ? (
        <p className="text-[11px] text-faint">
          No account uploads a list in Settings › Automation, so there is no upload state to show.
        </p>
      ) : null}
    </section>
  );
}

/** The recorded session the plan describes, when it is the day the baskets show. */
export function recordedSession(plan: RotationPlan | null, day: string | null): PlanSession | null {
  const s = sessionOf(plan, 'recorded');
  return s && day && s.day === day ? s : null;
}
