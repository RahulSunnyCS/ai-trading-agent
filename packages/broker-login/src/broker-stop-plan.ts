/**
 * The decisions of AlgoTest's daily book stop (`broker-stop.ts`), free of any browser.
 *
 * AlgoTest keeps one MTM stop per broker ("Broker Settings" under its card on /live). `GET /brokers`
 * gives it as `v2_settings.non_signal_settings.state.{config, is_active}` and the web app saves it with
 * `PUT /update-broker-settings/v2/<broker _id>?is_signal=false`, a body of all four fields
 * (read from its JavaScript, 2026-11-27). A field sent as null is cleared, so the owner's target and
 * trail are sent back as they are.
 */

/** After this minute (09:15 IST) the stop is only read: a new one could square positions off. */
export const MARKET_OPEN = 9 * 60 + 15;

/** What a doubled pick with no stop of its own adds, per extra lot (the owner's rule, BL-183). */
export const NO_STOP_EXTRA_INR = 4000;

export interface Kept {
  Target: unknown;
  OverallTrailSL: unknown;
  LockAndTrail: unknown;
}

export interface BrokerStop {
  /** AlgoTest's `_id` of the broker */
  id: string;
  /** the stop in force, in rupees of loss; null when none is */
  stopLoss: number | null;
  /** the target and trail in force, sent back unchanged */
  kept: Kept;
}

const NOTHING_KEPT: Kept = { Target: null, OverallTrailSL: null, LockAndTrail: null };

/** One broker's stop from `GET /brokers`; nothing else of the entry (its keys) is read. */
export function parseBrokerStop(json: unknown, algotestId: string): BrokerStop {
  const list = (json as { brokers?: unknown } | null)?.brokers;
  if (!Array.isArray(list)) throw new Error('AlgoTest /brokers: no brokers list');
  const found = (list as Record<string, unknown>[]).filter(
    (b) => b.deleted !== true && b.broker === algotestId,
  );
  const [entry] = found;
  if (found.length !== 1 || !entry)
    throw new Error(`AlgoTest /brokers: ${found.length} entries for ${algotestId}, expected 1`);
  const id = String(entry._id ?? '');
  if (!/^[\w-]+$/.test(id)) throw new Error(`AlgoTest /brokers: unusable id for ${algotestId}`);
  const state = (
    entry.v2_settings as { non_signal_settings?: { state?: Record<string, unknown> } } | undefined
  )?.non_signal_settings?.state;
  if (state?.is_active !== true) return { id, stopLoss: null, kept: NOTHING_KEPT };
  const config = (state.config ?? {}) as Record<string, unknown>;
  const stop = config.StopLoss;
  if (stop !== null && stop !== undefined && typeof stop !== 'number')
    throw new Error(`AlgoTest's stop for ${algotestId} is not a number: ${JSON.stringify(stop)}`);
  return {
    id,
    stopLoss: typeof stop === 'number' ? Math.abs(stop) : null,
    kept: {
      Target: config.Target ?? null,
      OverallTrailSL: config.OverallTrailSL ?? null,
      LockAndTrail: config.LockAndTrail ?? null,
    },
  };
}

export type Decision =
  | { kind: 'holds' }
  | { kind: 'set'; body: Kept & { StopLoss: number } }
  | { kind: 'left'; why: string };

export function decide(current: BrokerStop, rupees: number, nowMinutes: number): Decision {
  if (current.stopLoss === rupees) return { kind: 'holds' };
  if (nowMinutes >= MARKET_OPEN) {
    return {
      kind: 'left',
      why:
        current.stopLoss === null
          ? 'no stop, and the market is open: set it on /live by hand'
          : 'the market is open: left as it is',
    };
  }
  return { kind: 'set', body: { StopLoss: rupees, ...current.kept } };
}

/** Did the save take: the new stop in force, target and trail as they were? */
export function saved(after: BrokerStop, rupees: number, before: BrokerStop): boolean {
  return after.stopLoss === rupees && JSON.stringify(after.kept) === JSON.stringify(before.kept);
}

export interface StopExport {
  day: string;
  dir_boost?: boolean | undefined;
  split?: string | undefined;
  strategies: Array<{ name: string; addon?: boolean; lots?: number | undefined; file: string }>;
}

/**
 * BL-183: how far the stop rises on a session whose export trades a pick at more than 1 lot (the
 * picked Dir on a non-expiry day): that pick's own overall stop per lot times its extra lots (₹4,000
 * a lot when it has none). An AlgoTest export keeps the 1-lot figure. 0 when nothing is doubled.
 */
export function stopExtra(manifest: StopExport, docs: ReadonlyMap<string, unknown>): number {
  if (!manifest.dir_boost) return 0;
  let extra = 0;
  for (const s of manifest.strategies) {
    const lots = s.lots ?? 1;
    if (s.addon || lots <= 1) continue;
    const overall = (
      docs.get(s.name) as { strategy?: { OverallSL?: { Type?: string; Value?: unknown } } }
    )?.strategy?.OverallSL;
    const perLot =
      overall?.Type === 'OverallTgtSLType.MTM' && typeof overall.Value === 'number'
        ? Math.abs(overall.Value)
        : NO_STOP_EXTRA_INR;
    extra += perLot * (lots - 1);
  }
  return Math.round(extra);
}
