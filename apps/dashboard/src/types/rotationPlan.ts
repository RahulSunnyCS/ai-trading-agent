/**
 * The Today page's baskets with what the platforms hold: `GET /legwise/rotation/plan`, built by
 * `rotation/plan.py` (dashboard review, 2026-10-28). Read-only; the upload state is replayed from
 * the broker-login jobs' own ledgers.
 */

export type PlanBook = 'core' | 't1';

export interface PlanPick {
  name: string;
  role: 'core' | 'buy';
  /** "09:47", or null for an id with no entry time */
  start: string | null;
  /** "N_dir_ITM1" */
  head: string;
  /** "SL21% · TSLnone · RECOST1 · MTMSL3000" */
  params: string;
}

export interface PlanSession {
  day: string;
  /** recorded: the journal's latest entry; tentative: the 16:00 message's list for the next session */
  kind: 'recorded' | 'tentative';
  on_time?: boolean;
  sent_on?: string | null;
  books: Partial<Record<PlanBook, PlanPick[]>>;
}

export interface PlanAccountState {
  /** created for the session, or held now for its weekday */
  uploaded: string[];
  /** switched on during the session (an enable, or the 15:40 switch-off of one that was on) */
  enabled: string[];
  /** every algo of the book held now for the session's weekday */
  held: string[];
  /** false where the platform keeps no deploy ledger here (AlgoTest) */
  deploys_known: boolean;
  /** held for the session but not picked */
  extra?: string[];
}

export interface PlanAccount {
  platform: 'algotest' | 'quantiply';
  broker: string;
  /** "Quantiply · Angel One" */
  label: string;
  book: PlanBook;
  state: Record<string, PlanAccountState> | { error: string };
}

export interface RotationPlan {
  sessions: PlanSession[];
  accounts: PlanAccount[];
  /** "settings v6", or why they could not be read */
  settings: string | null;
  paused_until: string | null;
}
