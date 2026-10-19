import { NAME_PREFIXES } from './strategy-plan.js';

/**
 * What the AlgoTest deployer (BL-138) does, decided without a browser. It deploys only the day's
 * recorded picks, each once, in entry-time order, within AlgoTest's 08:00–15:40 window and its
 * strategy limit ("n/6 Strategy Deployed"), never a pick whose entry minute has come, never with no
 * broker logged in. `docs/algotest-execution.md` §7 has the page this reads.
 */

export const WINDOW_OPEN = 8 * 60;
export const WINDOW_CLOSE = 15 * 60 + 40;
/** a pick is deployed only if its entry is at least this many minutes away */
export const LEAD_MINUTES = 1;

export interface ActivationRow {
  name: string;
  status: string;
  deployed: number;
  /** the seven execution-day cells, "-" when not ticked */
  days: string[];
}

export interface LiveState {
  brokersLoggedIn: number;
  brokersTotal: number;
  slotsUsed: number;
  slotsMax: number;
  rows: ActivationRow[];
}

export interface Pick {
  name: string;
  /** minutes after midnight IST */
  entry: number;
}

export interface DeployPlan {
  /** why nothing may be deployed now, or null */
  refused: string | null;
  deploy: Pick[];
  already: string[];
  tooLate: string[];
  missing: string[];
  noSlot: string[];
}

export function minutesOf(hhmm: string): number {
  const [h = '0', m = '0'] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

export function istMinutes(now: Date = new Date()): number {
  const ist = new Date(now.getTime() + 330 * 60_000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

export function planDeploy(picks: Pick[], live: LiveState, now: number): DeployPlan {
  const out: DeployPlan = {
    refused: null,
    deploy: [],
    already: [],
    tooLate: [],
    missing: [],
    noSlot: [],
  };
  if (now < WINDOW_OPEN || now >= WINDOW_CLOSE) {
    out.refused = 'outside AlgoTest deploy hours (08:00-15:40 IST)';
  } else if (live.brokersLoggedIn < 1) {
    out.refused = `no broker logged in on AlgoTest (Broker Login ${live.brokersLoggedIn}/${live.brokersTotal})`;
  }
  const rows = new Map(live.rows.map((r) => [r.name, r]));
  const candidates: Pick[] = [];
  for (const pick of [...picks].sort((a, b) => a.entry - b.entry)) {
    if (!NAME_PREFIXES.some((p) => pick.name.startsWith(p))) {
      out.missing.push(pick.name);
      continue;
    }
    const row = rows.get(pick.name);
    if (!row) out.missing.push(pick.name);
    else if (row.deployed > 0) out.already.push(pick.name);
    else if (pick.entry - now < LEAD_MINUTES) out.tooLate.push(pick.name);
    else candidates.push(pick);
  }
  if (out.refused) return out;
  const free = Math.max(0, live.slotsMax - live.slotsUsed);
  out.deploy = candidates.slice(0, free);
  out.noSlot = candidates.slice(free).map((p) => p.name);
  return out;
}

/** Tool strategies that would run again on a later day (a ticked execution day). */
export function repeating(live: LiveState): string[] {
  return live.rows
    .filter((r) => NAME_PREFIXES.some((p) => r.name.startsWith(p)))
    .filter((r) => r.days.some((d) => d !== '-'))
    .map((r) => r.name);
}

const ROW =
  /([^\n]+)\n+[A-Z]+\n+•\n+INTRADAY\n+([^\n]+)\n+(\d+) Deployed\n+((?:[^\n]+\n+){6}[^\n]+)/g;

/** The /live page's text (document.body.innerText) as counts and Activation rows. */
export function parseLive(text: string): LiveState {
  const broker = /Broker Login (\d+)\/(\d+)/.exec(text);
  const slots = /(\d+)\/(\d+) Strategy Deployed/.exec(text);
  const start = text.indexOf('\nActivation\n');
  const body = start >= 0 ? text.slice(start) : text;
  const rows: ActivationRow[] = [];
  for (const m of body.matchAll(ROW)) {
    rows.push({
      name: (m[1] ?? '').trim(),
      status: (m[2] ?? '').trim(),
      deployed: Number(m[3]),
      days: (m[4] ?? '')
        .split('\n')
        .map((d) => d.trim())
        .filter(Boolean)
        .slice(0, 7),
    });
  }
  return {
    brokersLoggedIn: broker ? Number(broker[1]) : 0,
    brokersTotal: broker ? Number(broker[2]) : 0,
    slotsUsed: slots ? Number(slots[1]) : 0,
    slotsMax: slots ? Number(slots[2]) : 0,
    rows,
  };
}
