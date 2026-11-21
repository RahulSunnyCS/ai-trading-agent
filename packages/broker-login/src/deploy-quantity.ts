/**
 * BL-209 Phase 3: what each AlgoTest account is to deploy, and at what quantity. Pure.
 *
 * A T1 export split across the two accounts lists, per account, the copies it trades: a plain
 * `T1 · <variant>` (1 lot) or `T1 · <variant> · ×2` (2 lots, the legs doubled in the file). The
 * morning activation does not deploy the ×N copies: it deploys the one-lot strategy on each
 * account and sets that account's Quantity Multiplier on the Activate sheet to N (owner,
 * 2026-11-06: "adjust the quantity also before activation"). A copy with no one-lot strategy in
 * the export is deployed as it is, at 1.
 */
import type { Broker } from './automation-settings.js';

/** `name` as AlgoTest holds it and the quantity to set for one account. */
export interface Placement {
  name: string;
  lots: number;
}

export interface Exported {
  strategies: readonly { name: string }[];
  split?: string | undefined;
  accounts?: Record<string, string[]> | undefined;
  alone?: Record<string, string[]> | undefined;
}

const COPY = /^(.*?)(?: · ×(\d+))?$/u;

/** `T1 · N_x_1002 · ×2` -> the one-lot name and 2. */
export function copyOf(name: string): { base: string; lots: number } {
  const m = COPY.exec(name);
  return { base: m?.[1] ?? name, lots: m?.[2] ? Number(m[2]) : 1 };
}

export interface Placements {
  byBroker: Map<Broker, Placement[]>;
  problem: string | null;
}

/**
 * Per uploading account, the strategies to deploy. `kept` is the list after the morning's add-on
 * rule; a name the export lists but `kept` does not is a pick left out on purpose.
 */
export function placements(
  manifest: Exported,
  kept: readonly { name: string }[],
  brokers: readonly Broker[],
): Placements {
  const byBroker = new Map<Broker, Placement[]>();
  const keptNames = new Set(kept.map((k) => k.name));
  const listed = new Set(manifest.strategies.map((s) => s.name));
  if (!manifest.split) {
    for (const b of brokers)
      byBroker.set(
        b,
        kept.map((k) => ({ name: k.name, lots: 1 })),
      );
    return { byBroker, problem: null };
  }
  // One account trading alone (the other paused or not uploading) takes the layout where it
  // trades everything; both uploading take the split.
  const first = brokers[0];
  const layout =
    brokers.length === 1 && first && manifest.alone?.[first]
      ? { [first]: manifest.alone[first] }
      : manifest.accounts;
  for (const b of brokers) {
    const names = layout?.[b];
    if (!names)
      return { byBroker, problem: `the split export has no list for ${b}: export it again` };
    const out: Placement[] = [];
    for (const name of names) {
      const { base, lots } = copyOf(name);
      if (keptNames.has(base)) out.push({ name: base, lots });
      else if (keptNames.has(name)) out.push({ name, lots: 1 });
      else if (!listed.has(base) && !listed.has(name))
        return { byBroker, problem: `the split export names ${name}, which it does not hold` };
      // else: an add-on the morning rule left out
    }
    byBroker.set(b, out);
  }
  return { byBroker, problem: null };
}

/** Every strategy to deploy once, with the quantity each account asks for it. */
export function deployList(byBroker: Map<Broker, Placement[]>): {
  names: string[];
  lots: Map<string, Partial<Record<Broker, number>>>;
} {
  const names: string[] = [];
  const lots = new Map<string, Partial<Record<Broker, number>>>();
  for (const [broker, list] of byBroker) {
    for (const p of list) {
      if (!lots.has(p.name)) {
        lots.set(p.name, {});
        names.push(p.name);
      }
      const row = lots.get(p.name);
      if (row) row[broker] = p.lots;
    }
  }
  return { names, lots };
}

/**
 * The export must have been made under the settings now in force (the manifest carries the
 * version, `obt rotation algotest-export --from-settings`): an export older than a change to the
 * split or a row's Dir ×2 is the wrong list for the accounts (2026-11-06: the 08:11 run activated
 * one made before the split and put every strategy on both accounts).
 */
export function staleExport(
  manifestVersion: number | null | undefined,
  settingsVersion: number,
): string | null {
  if (manifestVersion === settingsVersion) return null;
  const made =
    manifestVersion === null || manifestVersion === undefined
      ? 'with no settings version'
      : `under settings v${manifestVersion}`;
  return `the export was made ${made}, Settings › Automation is now v${settingsVersion}: export again (obt rotation algotest-export --from-settings --preview --only-missing), nothing activated`;
}
