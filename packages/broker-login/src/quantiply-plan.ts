import { type Mode, NAME_PREFIXES } from './strategy-plan.js';

/**
 * What the Quantiply uploader (BL-139) does, decided without a network: pure functions over the
 * day's export manifest (`obt rotation quantiply-export`), the ledger of every algo the tool
 * created or deleted, and Quantiply's list (`GET /algos/day-wise`). `quantiply-upload.ts` carries
 * it out over Quantiply's own API (`docs/algotest-execution.md`, "Quantiply algos through its API").
 *
 * Quantiply keeps one algo per weekday, under an id, and the same name may appear on several days.
 * So the ledger is keyed by algo id, and a pick is wanted on one weekday only (the manifest's).
 *
 * - An algo is the tool's ("owned") only if the ledger's last successful action on its id is a
 *   create. Nothing else is ever deleted. A wanted name already on that weekday that the tool did
 *   not create is a conflict: alerted, never touched.
 * - Evening: owned algos that are listed and not wanted are deleted, on any weekday, but only
 *   when Quantiply shows them finished (`NOT_RUNNING` / `TRADE_CLOSED`) and either not enabled or
 *   enabled for today's weekday once today's session is over (`sessionOver`, 15:30 IST: before
 *   that, an enabled `NOT_RUNNING` algo may still be waiting for its entry). An owned algo that may be running, or is
 *   enabled for another day (it would trade then), is kept and alerted. Wanted algos missing on
 *   the weekday are created; an owned one with different content is replaced on the same rules.
 * - Morning (`topup`): only missing picks are created. Nothing is deleted; owned algos on today's
 *   weekday that are not today's picks are reported.
 * - A pick whose export lists an unconfirmed mapping is never created; it is reported.
 */

export interface QManifestEntry {
  variant: string;
  name: string;
  addon: boolean;
  file: string;
  unconfirmed: string[];
}

export interface QManifest {
  day: string;
  weekday: string;
  book: string;
  source: string;
  strategies: QManifestEntry[];
}

export interface QAlgo {
  id: string;
  name: string;
  day: string;
  enabled: boolean;
  status: string;
}

export interface QLedgerRow {
  at: string;
  day: string;
  weekday: string;
  mode: Mode;
  action: 'create' | 'delete';
  id: string;
  name: string;
  sha: string;
  ok: boolean;
  detail?: string;
}

export interface QWanted {
  name: string;
  variant: string;
  file: string;
  sha: string;
  unconfirmed: string[];
}

export interface QPlan {
  keep: string[];
  /** the owned copies `keep` stands for (their content is the export's): checked for the broker */
  kept: QAlgo[];
  create: QWanted[];
  /** owned algos to delete, with why they are deletable */
  delete: QAlgo[];
  /**
   * BL-172 (owner, 2026-10-28: "delete everything, my own algos too"): algos the tool did not
   * create, finished and switched off, deleted in the evening with `deleteOthers`. Never one that
   * is enabled or may still run, and never one with a picked name (that is a conflict).
   */
  deleteOthers: QAlgo[];
  /** owned, to be deleted, but maybe running or enabled for a later day: kept and alerted */
  heldBack: QAlgo[];
  /** a wanted name on the weekday that the tool did not create */
  conflicts: string[];
  /** owned algos on today's weekday that are not today's picks (morning only) */
  notToday: string[];
  /**
   * The same, but ENABLED: the owner deployed last night's preview pick that 09:16 dropped, so it
   * will trade real money today unless they disable it. Always needs the owner (morning only).
   */
  enabledNotToday: string[];
  /** a wanted name the tool owns with different content (morning only: alerted, left alone) */
  changed: string[];
  /** picks with a mapping not yet seen saved: never created */
  unconfirmed: QWanted[];
}

/** Statuses after which an algo has nothing open. Any other status may be live. */
export const FINISHED = new Set(['NOT_RUNNING', 'TRADE_CLOSED']);

export const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

/** From this IST minute an enabled algo for today can no longer be waiting for its entry. */
export const SESSION_OVER_MINUTES = 15 * 60 + 30;

/** Is today's session over (IST), so an enabled algo for today is done for the day? */
export function sessionOver(now: Date = new Date()): boolean {
  const ist = new Date(now.getTime() + 330 * 60_000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes() >= SESSION_OVER_MINUTES;
}

/** The weekday of a `YYYY-MM-DD` date, as Quantiply writes it (`WED`). */
export function weekdayOf(isoDay: string): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`not a date: ${isoDay}`);
  return WEEKDAYS[d.getUTCDay()] ?? 'SUN';
}

/** The IST weekday of `now`, as Quantiply writes it (`MON`). */
export function istWeekday(now: Date = new Date()): string {
  return WEEKDAYS[new Date(now.getTime() + 330 * 60_000).getUTCDay()] ?? 'SUN';
}

export function parseQLedger(text: string): QLedgerRow[] {
  const rows: QLedgerRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as QLedgerRow | null;
      // a line that is JSON but not a ledger row (`null`, a number) is skipped like a torn one
      if (
        row &&
        typeof row === 'object' &&
        typeof row.id === 'string' &&
        typeof row.name === 'string'
      )
        rows.push(row);
    } catch {
      // a torn last line (a crash mid-write) is skipped, never fatal
    }
  }
  return rows;
}

/** algo id -> the ledger's create row, for each algo the tool created and has not deleted. */
export function ownedIds(ledger: QLedgerRow[]): Map<string, QLedgerRow> {
  const out = new Map<string, QLedgerRow>();
  for (const row of ledger) {
    if (!row.ok || !row.id || !NAME_PREFIXES.some((p) => row.name.startsWith(p))) continue;
    if (row.action === 'create') out.set(row.id, row);
    else out.delete(row.id);
  }
  return out;
}

/** `GET /algos/day-wise`'s `data` (one entry per weekday, each with `algos`) as a flat list. */
export function parseDayWise(json: unknown): QAlgo[] {
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error('day-wise list: no data array');
  const out: QAlgo[] = [];
  for (const day of data as { day?: string; algos?: unknown }[]) {
    if (!Array.isArray(day.algos)) throw new Error(`day-wise list: ${day.day} has no algos array`);
    for (const a of day.algos as Record<string, unknown>[]) {
      if (typeof a._id !== 'string' || typeof a.name !== 'string')
        throw new Error('day-wise list: an algo without _id or name');
      out.push({
        id: a._id,
        name: a.name,
        day: typeof a.day === 'string' ? a.day : String(day.day),
        enabled: a.enabled === true,
        status: typeof a.status === 'string' ? a.status : 'UNKNOWN',
      });
    }
  }
  return out;
}

/** When an evening plan may delete an owned algo: today, and whether today's session is over. */
export interface Today {
  weekday: string;
  sessionOver: boolean;
}

function deletable(a: QAlgo, today: Today): boolean {
  if (!FINISHED.has(a.status)) return false;
  return !a.enabled || (a.day === today.weekday && today.sessionOver);
}

export function planQ(
  mode: Mode,
  weekday: string,
  today: Today,
  wanted: QWanted[],
  ledger: QLedgerRow[],
  algos: QAlgo[],
  opts: { deleteOthers?: boolean } = {},
): QPlan {
  const mine = ownedIds(ledger);
  const out: QPlan = {
    keep: [],
    kept: [],
    create: [],
    delete: [],
    deleteOthers: [],
    heldBack: [],
    conflicts: [],
    notToday: [],
    enabledNotToday: [],
    changed: [],
    unconfirmed: [],
  };
  const listed = new Map(algos.map((a) => [a.id, a]));
  const onDay = algos.filter((a) => a.day === weekday);
  const wantedNames = new Set(wanted.map((w) => w.name));
  const handled = new Set<string>();

  for (const w of wanted) {
    const same = onDay.filter((a) => a.name === w.name);
    const ours = same.filter((a) => mine.has(a.id));
    if (same.length > ours.length) {
      out.conflicts.push(w.name);
      for (const a of ours) handled.add(a.id);
      continue;
    }
    if (ours.length === 0) {
      if (w.unconfirmed.length) out.unconfirmed.push(w);
      else out.create.push(w);
      continue;
    }
    for (const a of ours) handled.add(a.id);
    const fresh = ours.filter((a) => mine.get(a.id)?.sha === w.sha);
    if (mode === 'topup') {
      if (fresh.length) {
        out.keep.push(w.name);
        out.kept.push(...fresh);
      } else out.changed.push(w.name);
      continue;
    }
    // Evening: keep one current copy; delete stale content (a strategy file was edited) and
    // duplicates, if safe; create afresh when no current copy is left.
    const extra = fresh.length ? ours.filter((a) => a !== fresh[0]) : ours;
    const blocked = extra.filter((a) => !deletable(a, today));
    if (blocked.length) {
      out.heldBack.push(...blocked);
      continue;
    }
    out.delete.push(...extra);
    if (fresh[0]) {
      out.keep.push(w.name);
      out.kept.push(fresh[0]);
    } else if (w.unconfirmed.length) out.unconfirmed.push(w);
    else out.create.push(w);
  }

  for (const [id] of mine) {
    const a = listed.get(id);
    if (!a || handled.has(id)) continue;
    if (mode === 'topup') {
      if (a.day === weekday && !wantedNames.has(a.name)) {
        if (a.enabled) out.enabledNotToday.push(a.name);
        else out.notToday.push(a.name);
      }
      continue;
    }
    if (deletable(a, today)) out.delete.push(a);
    else out.heldBack.push(a);
  }
  if (mode === 'evening' && opts.deleteOthers) {
    for (const a of algos) {
      if (mine.has(a.id) || handled.has(a.id) || wantedNames.has(a.name)) continue;
      // switched off and finished only: the owner's own enabled algo is never touched
      if (!a.enabled && FINISHED.has(a.status)) out.deleteOthers.push(a);
    }
  }
  return out;
}

/** An algo's broker as `GET /algos/:id` reads it (`parseDetail` in quantiply-deploy-plan.ts). */
export interface BrokerState {
  enabled: boolean;
  /** '' = unset */
  broker: string;
}

/**
 * The uploader's broker step, before the call, for an owned algo whose content is the export's:
 * `set` it to the account's broker, it is `done`, or it is skipped (why). Quantiply's broker menu
 * is read-only once set, so another account's broker is never sent over; an enabled algo with
 * none is left as the owner put it.
 */
export function brokerBefore(s: BrokerState, brokerId: string): 'set' | 'done' | { skip: string } {
  if (s.broker === brokerId) return 'done';
  if (s.broker) return { skip: 'its broker is another account' };
  if (s.enabled) return { skip: 'ENABLED with no broker: left as it is' };
  return 'set';
}

export interface BrokerOutcome {
  ok: boolean;
  /** for the run's report */
  note: string;
  /** enabled under the call: switch it off at once (the uploader never leaves one on) */
  switchOff: boolean;
  /** the content changed under the call: own it under a sha no export matches */
  mismatch: boolean;
  /** a later run may fix it (a network blip); otherwise the owner looks */
  retry: boolean;
}

/**
 * After the broker call, from one fresh read-back (`after`, or why it failed). `callError` is the
 * call's own error; `refused` = a definite refusal (a 4xx, or never sent: `definitelyRefused`). A
 * call that errored may still have applied, so the read-back decides. A read-back that failed
 * leaves the content as it was checked before the call: never a mismatch, a retry (the next run
 * finds the algo kept and checks it again).
 */
export function brokerOutcome(i: {
  brokerId: string;
  callError?: { text: string; refused: boolean };
  after: BrokerState | { failed: string };
  diffs: string[];
}): BrokerOutcome {
  if ('failed' in i.after) {
    const why = i.callError ? `${i.callError.text}; read back: ${i.after.failed}` : i.after.failed;
    return {
      ok: false,
      note: `broker not confirmed (${why})`,
      switchOff: false,
      mismatch: false,
      retry: !i.callError?.refused,
    };
  }
  const switchOff = i.after.enabled;
  const mismatch = i.diffs.length > 0;
  const set = i.after.broker === i.brokerId;
  const notes: string[] = [];
  if (switchOff) notes.push('ENABLED after the broker call');
  if (mismatch)
    notes.push(`content changed under the broker call: ${i.diffs.slice(0, 3).join(', ')}`);
  if (!set) {
    notes.push(
      i.callError
        ? `broker not set: ${i.callError.text}`
        : 'broker reads back unset or another account',
    );
  }
  return {
    ok: !switchOff && !mismatch && set,
    note: notes.length ? notes.join('; ') : 'broker set',
    switchOff,
    mismatch,
    retry: !set && !switchOff && !mismatch && !!i.callError && !i.callError.refused,
  };
}

export function summaryQ(p: QPlan, mode: Mode, deploysItself = false): string[] {
  const lines: string[] = [];
  const algo = (a: QAlgo) => `${a.name} (${a.day}${a.enabled ? ', enabled' : ''}, ${a.status})`;
  if (p.keep.length) lines.push(`ready: ${p.keep.join(', ')}`);
  if (p.create.length) lines.push(`create: ${p.create.map((w) => w.name).join(', ')}`);
  if (p.delete.length) lines.push(`delete: ${p.delete.map(algo).join(', ')}`);
  if (p.deleteOthers.length)
    lines.push(`delete (not the tool's): ${p.deleteOthers.map(algo).join(', ')}`);
  if (p.heldBack.length)
    lines.push(`NOT deleted, may run or is enabled: ${p.heldBack.map(algo).join(', ')}`);
  if (p.conflicts.length)
    lines.push(`NOT touched, same name made by hand: ${p.conflicts.join(', ')}`);
  if (p.changed.length)
    lines.push(`NOT replaced in the morning, content changed: ${p.changed.join(', ')}`);
  if (p.unconfirmed.length)
    lines.push(
      `NOT created, a setting never seen saved: ${p.unconfirmed
        .map((w) => `${w.name} (${w.unconfirmed.join('; ')})`)
        .join(', ')}`,
    );
  if (p.enabledNotToday.length) {
    lines.push(
      deploysItself
        ? `enabled, no longer today's pick: the 09:21 switch-on turns it off if it has not started: ${p.enabledNotToday.join(', ')}`
        : `⚠️ ENABLED but no longer today's pick, it WILL TRADE unless you disable it: ${p.enabledNotToday.join(', ')}`,
    );
  }
  if (mode === 'topup' && p.notToday.length) lines.push(`not today: ${p.notToday.join(', ')}`);
  if (!lines.length) lines.push('nothing to do');
  return lines;
}

/** Anything kept, skipped or changed against the plan's intent: the owner should look. */
export function needsAttentionQ(p: QPlan, deploysItself = false): boolean {
  // BL-172: with the tool's own switch-on in charge (QUANTIPLY_DEPLOY and Automated deployment
  // on), an enabled algo 09:16 dropped is the 09:21 run's to switch off, not the owner's.
  return (
    p.heldBack.length +
      p.conflicts.length +
      p.changed.length +
      p.unconfirmed.length +
      (deploysItself ? 0 : p.enabledNotToday.length) >
    0
  );
}

/** Keys Quantiply adds or rewrites on save; ignored at the top level of a read-back. */
export const SERVER_KEYS = new Set([
  '_id',
  '__v',
  'user',
  'createdAt',
  'updatedAt',
  'enabled',
  'algoType',
  'status',
  'hasError',
  'entryErrorCount',
  'exitErrorCount',
  'hasWaiting',
  'hasWaitingWT',
  'broker',
  'day',
]);

/**
 * BL-140 Phase 4: the export's text for an account whose row runs at `multiplier` (1-10), with
 * `configurations.multiplier` set to it. The export (like the web app's own create request) has no
 * `multiplier`: Quantiply adds `multiplier: 1` to the saved algo, so at N above 1 the key is added
 * here, and the read-back (`readBackDiffs`) then shows whether Quantiply saved it. At 1 the text is
 * returned untouched, so the upload, its sha and the read-back are exactly what they were before
 * the setting existed. The uploader, the deployer and the ledger's sha all go through here, so a
 * changed multiplier is a changed algo (replaced in the evening) and an old one is never enabled.
 * A body that is not an export (no `configurations`, or a multiplier already set to something
 * other than 1) is refused.
 */
export function withMultiplier(text: string, multiplier: number): string {
  if (!(Number.isInteger(multiplier) && multiplier >= 1 && multiplier <= 10)) {
    throw new Error(`multiplier ${multiplier} is not a whole number from 1 to 10`);
  }
  if (multiplier === 1) return text;
  const body = JSON.parse(text) as { configurations?: Record<string, unknown> };
  const cfg = body.configurations;
  if (!cfg || typeof cfg !== 'object' || (cfg.multiplier !== undefined && cfg.multiplier !== 1)) {
    throw new Error(
      `the export's configurations.multiplier is ${JSON.stringify(cfg?.multiplier)}, not absent or 1: not applying ${multiplier}`,
    );
  }
  cfg.multiplier = multiplier;
  return JSON.stringify(body);
}

/**
 * Paths of the sent `body` whose saved value (`GET /algos/:id`'s algo) differs. Keys only the
 * server adds (its defaults) are ignored; every key we sent must come back unchanged. The same
 * rule as `legwise/quantiply.py`'s `comparable`.
 */
export function readBackDiffs(body: Record<string, unknown>, saved: unknown): string[] {
  const diffs: string[] = [];
  const walk = (sent: unknown, got: unknown, path: string): void => {
    if (sent && typeof sent === 'object' && !Array.isArray(sent)) {
      if (!got || typeof got !== 'object' || Array.isArray(got)) {
        diffs.push(path || '/');
        return;
      }
      for (const [k, v] of Object.entries(sent)) {
        if (!path && SERVER_KEYS.has(k)) continue;
        const has = Object.hasOwn(got, k);
        if (!has) {
          diffs.push(path ? `${path}.${k}` : k);
          continue;
        }
        walk(v, (got as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
      }
    } else if (Array.isArray(sent)) {
      if (!Array.isArray(got) || got.length !== sent.length) {
        diffs.push(path);
        return;
      }
      sent.forEach((v, i) => walk(v, got[i], `${path}[${i}]`));
    } else if (sent !== got) {
      diffs.push(path);
    }
  };
  const { day: _day, ...rest } = body;
  walk(rest, saved, '');
  return diffs;
}

/** BL-172 Phase 7: the paid Quantiply's (Shoonya's) subscription, as `GET /users/me` gives it. */
export interface QSubscription {
  id: string;
  plan: string;
  /** algos a day the plan includes */
  algosPerDay: number;
  /** algos a day bought on top */
  additionalAlgos: number;
  totalAlgosPerDay: number;
}

export function parseSubscription(json: unknown): QSubscription {
  const data = ((json as { data?: unknown }).data ?? json) as { subscription?: unknown };
  const s = data.subscription as Record<string, unknown> | undefined;
  const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : Number.NaN);
  if (!s || typeof s._id !== 'string' || typeof s.plan !== 'string')
    throw new Error('no subscription on the account');
  const sub = {
    id: s._id,
    plan: s.plan,
    algosPerDay: num(s.algosPerDay),
    additionalAlgos: num(s.additionalAlgos),
    totalAlgosPerDay: num(s.totalAlgosPerDay),
  };
  if ([sub.algosPerDay, sub.additionalAlgos, sub.totalAlgosPerDay].some(Number.isNaN))
    throw new Error('the subscription has no algo counts');
  return sub;
}

/**
 * The extra algos to buy so the account runs exactly `need` a day (the owner, 2026-10-28: the
 * tool's own need; they add their own by hand). Null when it already does. `skip` when the tool
 * must not ask: the web app never sends an extra of 0 (it leaves the field out), so what the server
 * does with one is unknown.
 */
export function subscriptionTarget(
  sub: QSubscription,
  need: number,
): { extra: number } | { skip: string } | null {
  const extra = Math.max(0, need - sub.algosPerDay);
  if (extra === sub.additionalAlgos) return null;
  if (extra === 0)
    return {
      skip: `${need} a day is within the plan's ${sub.algosPerDay}: set no extra algos in Subscription by hand (the tool never asks for 0)`,
    };
  return { extra };
}

/** The credits a previewed change costs (+) or returns (-): the sum of its line items. */
export function previewNet(json: unknown): number | null {
  const items = ((json as { data?: { lineItems?: unknown } }).data ?? {}).lineItems;
  if (!Array.isArray(items) || !items.length) return null;
  let total = 0;
  for (const it of items as Record<string, unknown>[]) {
    const v = it.payableCredits ?? it.credits;
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    total += v;
  }
  return total;
}
