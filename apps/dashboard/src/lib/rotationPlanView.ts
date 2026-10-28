/**
 * Pure helpers for the Today page's baskets: each pick's settings and its state on every account
 * that uploads its book (`rotation/plan.py` replays the ledgers; this file only reads and words
 * it). Missing is said, never read as "not uploaded".
 */

import type { Tone } from '../components/ui/Badge';
import type {
  PlanAccount,
  PlanAccountState,
  PlanBook,
  PlanPick,
  PlanSession,
  RotationPlan,
} from '../types/rotationPlan';
import { formatDay } from './format';

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface PickChip {
  account: string;
  text: string;
  tone: Tone;
  title: string;
}

function stateFor(a: PlanAccount, day: string): PlanAccountState | { error: string } | null {
  if ('error' in a.state) return { error: String(a.state.error) };
  return (a.state as Record<string, PlanAccountState>)[day] ?? null;
}

/** The accounts that upload `book`, in the order the API gives them. */
export function accountsFor(plan: RotationPlan, book: PlanBook): PlanAccount[] {
  return plan.accounts.filter((a) => a.book === book);
}

/** One chip per account that uploads the book: on, uploaded, not uploaded, or why it is unknown. */
export function pickChips(
  plan: RotationPlan,
  book: PlanBook,
  day: string,
  name: string,
  kind: PlanSession['kind'],
): PickChip[] {
  return accountsFor(plan, book).map((a) => {
    const st = stateFor(a, day);
    if (st === null) {
      return { account: a.label, text: 'unknown', tone: 'neutral', title: `${a.label}: not read` };
    }
    if ('error' in st) {
      return {
        account: a.label,
        text: 'no ledger',
        tone: 'neutral',
        title: `${a.label}: ${st.error}`,
      };
    }
    const uploaded = st.uploaded.includes(name);
    const on = st.enabled.includes(name);
    if (on) {
      return {
        account: a.label,
        text: kind === 'recorded' ? 'was on' : 'on',
        tone: 'positive',
        title: `${a.label}: uploaded and switched on for ${formatDay(day)}`,
      };
    }
    if (uploaded) {
      return {
        account: a.label,
        text: 'uploaded',
        tone: 'info',
        title: st.deploys_known
          ? `${a.label}: uploaded for ${formatDay(day)}, not switched on${kind === 'recorded' ? '' : ' yet'}`
          : `${a.label}: uploaded; switching on is done on the platform and not recorded here`,
      };
    }
    return {
      account: a.label,
      text: 'not uploaded',
      tone: 'warning',
      title: `${a.label}: no upload of this pick for ${formatDay(day)} in the ledger`,
    };
  });
}

/** "Quantiply · Angel One also holds S_p250_1317 for Wed: not picked, trades only if switched on." */
export function extraLines(plan: RotationPlan, book: PlanBook, day: string): string[] {
  const weekday = WEEKDAY[new Date(`${day}T00:00:00Z`).getUTCDay()] ?? day;
  return accountsFor(plan, book).flatMap((a) => {
    const st = stateFor(a, day);
    if (st === null || 'error' in st || !st.extra?.length) return [];
    return [
      `${a.label} also holds ${st.extra.join(', ')} for ${weekday}: not picked; it trades only if switched on.`,
    ];
  });
}

export function sessionOf(
  plan: RotationPlan | null,
  kind: PlanSession['kind'],
): PlanSession | null {
  return plan?.sessions.find((s) => s.kind === kind) ?? null;
}

/** A pick's settings line from the plan, for the session and book it belongs to. */
export function settingsOf(
  session: PlanSession | null,
  book: PlanBook,
  name: string,
): PlanPick | null {
  return session?.books[book]?.find((p) => p.name === name) ?? null;
}
