import { createHash } from 'node:crypto';

/**
 * What the AlgoTest strategy uploader (BL-137) does, decided without a browser: pure functions over
 * the day's export manifest (`obt rotation algotest-export`), the ledger of everything the tool
 * has uploaded or deleted, and what AlgoTest lists right now. `strategy-upload.ts` carries it out.
 *
 * - A strategy is the tool's ("owned") only if the ledger's last successful action on that name is
 *   an upload. Nothing else is ever deleted, and an AlgoTest strategy with a wanted name that the
 *   tool did not upload is a conflict: alerted, never overwritten.
 * - Evening (`evening`): owned strategies that tomorrow's picks no longer contain, or contain with
 *   different content, are deleted, unless AlgoTest shows them deployed on /live (the owner's
 *   activation, which repeats on its weekdays): then they are kept and alerted. Wanted strategies
 *   that are missing are uploaded. An unchanged owned strategy is left alone.
 * - Morning (`topup`, after the 09:16 pick): only the missing picks are uploaded. Nothing is
 *   deleted; owned strategies that are not today's picks are reported as "not today".
 */

export type Mode = 'evening' | 'topup';

export interface ManifestEntry {
  variant: string;
  name: string;
  addon: boolean;
  file: string;
}

export interface Manifest {
  day: string;
  book: string;
  source: string;
  strategies: ManifestEntry[];
}

export interface LedgerRow {
  at: string;
  day: string;
  book: string;
  mode: Mode;
  action: 'upload' | 'delete';
  name: string;
  sha: string;
  ok: boolean;
  detail?: string;
  /** AlgoTest's `_id` of the saved strategy (uploads since 2026-10-20); a delete needs it */
  id?: string;
}

export interface Wanted {
  name: string;
  variant: string;
  file: string;
  sha: string;
}

export interface Plan {
  keep: string[];
  upload: Wanted[];
  delete: string[];
  /** owned, to be deleted, but deployed on /live: left in place and alerted */
  deployedKept: string[];
  /** a wanted name that exists in AlgoTest but was not uploaded by the tool */
  conflicts: string[];
  /** owned and present but not among the picks (morning only) */
  notToday: string[];
  /** a wanted name the tool owns with different content (morning only: alerted, left alone) */
  changed: string[];
}

/**
 * Every name prefix the tool has ever given its strategies and algos. APPEND-ONLY: a rename (the
 * planned TA / CA one) adds its new prefixes and keeps the old ones. Ownership (`owned`, Quantiply's
 * `ownedIds`), the 15:40 disable and the stop button all match on this list, so dropping an old
 * prefix would silently stop them treating that day's still-live strategies as the tool's.
 * `strategy-plan.test.ts` pins the old prefixes.
 */
export const NAME_PREFIXES: readonly string[] = ['T1 · ', 'Core · '];

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function parseLedger(text: string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as LedgerRow);
    } catch {
      // a torn last line (a crash mid-write) is skipped, never fatal
    }
  }
  return rows;
}

/** name -> content sha of each strategy the tool uploaded and has not since deleted. */
export function owned(ledger: LedgerRow[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of ledger) {
    if (!row.ok || !NAME_PREFIXES.some((p) => row.name.startsWith(p))) continue;
    if (row.action === 'upload') out.set(row.name, row.sha);
    else out.delete(row.name);
  }
  return out;
}

/** The `_id` the tool recorded for each name it owns (the latest ok upload that has one). */
export function ownedIds(ledger: LedgerRow[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of ledger) {
    if (!row.ok || !NAME_PREFIXES.some((p) => row.name.startsWith(p))) continue;
    if (row.action === 'upload') {
      if (row.id) out.set(row.name, row.id);
      else out.delete(row.name);
    } else out.delete(row.name);
  }
  return out;
}

/**
 * What a fresh listing says after deleting `id`: still there, and which other strategies (as
 * "name (id)") were there before and are missing now. Any missing other one stops everything.
 */
export function afterDelete(
  before: Map<string, string[]>,
  after: Map<string, string[]>,
  id: string,
): { stillListed: boolean; vanished: string[] } {
  const now = new Set([...after.values()].flat());
  const vanished: string[] = [];
  for (const [name, ids] of before)
    for (const other of ids)
      if (other !== id && !now.has(other)) vanished.push(`${name} (${other})`);
  return { stillListed: now.has(id), vanished };
}

/** The `_id` in a save answer (`{_id}`, under `data`, or `id`), if it has one. */
export function savedId(body: unknown): string | undefined {
  const b = (body ?? {}) as Record<string, unknown>;
  const id = b._id ?? (b.data as Record<string, unknown> | undefined)?._id ?? b.id;
  return typeof id === 'string' && /^[0-9a-f]{24}$/i.test(id) ? id : undefined;
}

/** The one id listed under `name` now that was not before an upload, if exactly one. */
export function newIdFor(
  before: Map<string, string[]>,
  after: Map<string, string[]>,
  name: string,
): string | undefined {
  const old = new Set(before.get(name) ?? []);
  const added = (after.get(name) ?? []).filter((id) => !old.has(id));
  return added.length === 1 ? added[0] : undefined;
}

export function plan(
  mode: Mode,
  wanted: Wanted[],
  ledger: LedgerRow[],
  existing: Set<string>,
  deployed: Set<string>,
): Plan {
  const mine = owned(ledger);
  const out: Plan = {
    keep: [],
    upload: [],
    delete: [],
    deployedKept: [],
    conflicts: [],
    notToday: [],
    changed: [],
  };
  const wantedByName = new Map(wanted.map((w) => [w.name, w]));

  for (const w of wanted) {
    const present = existing.has(w.name);
    const ownSha = mine.get(w.name);
    if (!present) {
      out.upload.push(w);
    } else if (ownSha === undefined) {
      out.conflicts.push(w.name);
    } else if (ownSha === w.sha) {
      out.keep.push(w.name);
    } else if (mode === 'evening') {
      // content changed (a strategy file was edited): replace it, unless it is deployed
      if (deployed.has(w.name)) out.deployedKept.push(w.name);
      else {
        out.delete.push(w.name);
        out.upload.push(w);
      }
    } else {
      out.changed.push(w.name);
    }
  }

  for (const name of mine.keys()) {
    if (wantedByName.has(name) || !existing.has(name)) continue;
    if (mode === 'topup') out.notToday.push(name);
    else if (deployed.has(name)) out.deployedKept.push(name);
    else out.delete.push(name);
  }
  return out;
}

export function summary(p: Plan, mode: Mode): string[] {
  const lines: string[] = [];
  if (p.keep.length) lines.push(`ready: ${p.keep.join(', ')}`);
  if (p.upload.length) lines.push(`upload: ${p.upload.map((w) => w.name).join(', ')}`);
  if (p.delete.length) lines.push(`delete: ${p.delete.join(', ')}`);
  if (p.deployedKept.length)
    lines.push(`NOT deleted, still deployed on /live: ${p.deployedKept.join(', ')}`);
  if (p.conflicts.length)
    lines.push(`NOT touched, same name made by hand: ${p.conflicts.join(', ')}`);
  if (p.changed.length)
    lines.push(`NOT replaced in the morning, content changed: ${p.changed.join(', ')}`);
  if (mode === 'topup' && p.notToday.length) lines.push(`not today: ${p.notToday.join(', ')}`);
  if (!lines.length) lines.push('nothing to do');
  return lines;
}

/** Problems that need the owner: anything kept, skipped or changed against the plan's intent. */
export function needsAttention(p: Plan): boolean {
  return p.deployedKept.length > 0 || p.conflicts.length > 0 || p.changed.length > 0;
}

/** Every string under a name-like key, anywhere in AlgoTest's strategies response. */
export function namesIn(json: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const v of value) walk(v);
    } else if (value && typeof value === 'object') {
      for (const [key, v] of Object.entries(value)) {
        if (/^(name|strategy_?name|strategyName)$/i.test(key) && typeof v === 'string') out.add(v);
        else walk(v);
      }
    }
  };
  walk(json);
  return out;
}

/** The parts of an `.algtst` that must survive a save: everything but the leg ids. */
export function comparable(doc: unknown): string {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([k]) => k !== 'id')
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, strip(v)]),
      );
    }
    return value;
  };
  const d = doc as { strategy?: unknown };
  return JSON.stringify(strip(d.strategy ?? null));
}

/** Today's date in IST, YYYY-MM-DD, whatever the host's zone. */
export function istToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/**
 * The `_id`s of each exact strategy name in AlgoTest's `GET /strategies` response (an array of
 * `{ _id, name, folder, archived, template }`, seen 2026-10-20). A name can repeat, so each maps to
 * every id it has; a delete goes ahead only when its name has exactly one.
 */
export function idsByName(json: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!Array.isArray(json)) return out;
  for (const item of json) {
    if (!item || typeof item !== 'object') continue;
    const { _id, name } = item as Record<string, unknown>;
    if (typeof _id !== 'string' || typeof name !== 'string') continue;
    out.set(name, [...(out.get(name) ?? []), _id]);
  }
  return out;
}
