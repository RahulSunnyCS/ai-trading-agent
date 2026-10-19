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
  create: QWanted[];
  /** owned algos to delete, with why they are deletable */
  delete: QAlgo[];
  /** owned, to be deleted, but maybe running or enabled for a later day: kept and alerted */
  heldBack: QAlgo[];
  /** a wanted name on the weekday that the tool did not create */
  conflicts: string[];
  /** owned algos on today's weekday that are not today's picks (morning only) */
  notToday: string[];
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
      rows.push(JSON.parse(line) as QLedgerRow);
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
): QPlan {
  const mine = ownedIds(ledger);
  const out: QPlan = {
    keep: [],
    create: [],
    delete: [],
    heldBack: [],
    conflicts: [],
    notToday: [],
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
      if (fresh.length) out.keep.push(w.name);
      else out.changed.push(w.name);
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
    if (fresh.length) out.keep.push(w.name);
    else if (w.unconfirmed.length) out.unconfirmed.push(w);
    else out.create.push(w);
  }

  for (const [id] of mine) {
    const a = listed.get(id);
    if (!a || handled.has(id)) continue;
    if (mode === 'topup') {
      if (a.day === weekday && !wantedNames.has(a.name)) out.notToday.push(a.name);
      continue;
    }
    if (deletable(a, today)) out.delete.push(a);
    else out.heldBack.push(a);
  }
  return out;
}

export function summaryQ(p: QPlan, mode: Mode): string[] {
  const lines: string[] = [];
  const algo = (a: QAlgo) => `${a.name} (${a.day}${a.enabled ? ', enabled' : ''}, ${a.status})`;
  if (p.keep.length) lines.push(`ready: ${p.keep.join(', ')}`);
  if (p.create.length) lines.push(`create: ${p.create.map((w) => w.name).join(', ')}`);
  if (p.delete.length) lines.push(`delete: ${p.delete.map(algo).join(', ')}`);
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
  if (mode === 'topup' && p.notToday.length) lines.push(`not today: ${p.notToday.join(', ')}`);
  if (!lines.length) lines.push('nothing to do');
  return lines;
}

/** Anything kept, skipped or changed against the plan's intent: the owner should look. */
export function needsAttentionQ(p: QPlan): boolean {
  return p.heldBack.length + p.conflicts.length + p.changed.length + p.unconfirmed.length > 0;
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
