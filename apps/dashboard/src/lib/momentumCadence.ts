/**
 * Which Fridays a Momentum config trades on (BL-036 Phase 1 task 4), in words and as dates. The
 * engine's rule, mirrored: every N weeks trades the Fridays whose number of whole weeks since Friday
 * 1 Jan 2016 (`engine.CADENCE_EPOCH`) leaves `rebalance_offset` when divided by N
 * (`engine.cadence_weeks`); monthly trades the last Friday of each month
 * (`analysis.rebalance_weeks`). The server's own `explain` line stays the authority for a signal;
 * this only names the rule behind "phase N" and the next trading Friday where that line does not.
 */

/** Friday 1 Jan 2016: week 0 of every multi-week cadence. */
export const CADENCE_EPOCH = '2016-01-01';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

interface Cadence {
  monthly: boolean;
  every: number;
  offset: number;
  split: boolean;
}

function cadenceOf(config: Record<string, unknown>): Cadence {
  const every = Number(config.rebalance_every ?? 1);
  const offset = Number(config.rebalance_offset ?? 0);
  return {
    monthly: config.rebalance === 'monthly',
    every: Number.isFinite(every) && every > 1 ? Math.floor(every) : 1,
    offset: Number.isFinite(offset) ? Math.floor(offset) : 0,
    split: config.split_fridays === true,
  };
}

function utc(day: string): number | null {
  const time = Date.parse(`${day.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(time) ? null : time;
}

function isoDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** Whole weeks from 1 Jan 2016 to `day` (rounded, as the engine does). */
export function weeksSinceEpoch(day: string): number | null {
  const time = utc(day);
  const epoch = utc(CADENCE_EPOCH) as number;
  return time === null ? null : Math.round((time - epoch) / WEEK_MS);
}

function trades(time: number, cadence: Cadence): boolean {
  if (cadence.monthly) {
    return new Date(time + WEEK_MS).getUTCMonth() !== new Date(time).getUTCMonth();
  }
  if (cadence.every <= 1) return true;
  const weeks = weeksSinceEpoch(isoDay(time)) as number;
  return ((weeks % cadence.every) + cadence.every) % cadence.every === cadence.offset;
}

/**
 * The rule behind a config's trading Fridays, as one sentence; null when it trades every Friday
 * (or on every set of Fridays at once, an All (split) run, whose chip already says so).
 */
export function cadenceRule(config: Record<string, unknown>): string | null {
  const cadence = cadenceOf(config);
  if (cadence.monthly) return 'Trades on the last Friday of each month.';
  if (cadence.every <= 1 || cadence.split) return null;
  return phaseRule(cadence.every, cadence.offset);
}

/** "Phase 3 of 4 trades on the Fridays whose weeks since Fri 1 Jan 2016, divided by 4, leave 2." */
export function phaseRule(every: number, offset: number): string {
  return (
    `Phase ${offset + 1} of ${every} trades on the Fridays whose number of weeks since ` +
    `Friday 1 Jan 2016, divided by ${every}, leaves ${offset}.`
  );
}

/** Whether `week` (a Friday, 'YYYY-MM-DD') is a rebalance week under the config's cadence. */
export function isRebalanceWeek(week: string, config: Record<string, unknown>): boolean {
  const time = utc(week);
  return time === null ? false : trades(time, cadenceOf(config));
}

/**
 * The first Friday after `week` that trades under the config's cadence; null when every week
 * trades, for an All (split) run (each set of Fridays has its own), or for an unreadable week.
 */
export function nextRebalanceFriday(week: string, config: Record<string, unknown>): string | null {
  const cadence = cadenceOf(config);
  const time = utc(week);
  if (time === null || cadence.split || (!cadence.monthly && cadence.every <= 1)) return null;
  let following = time + WEEK_MS;
  // At most `every` weeks on (five for monthly); bounded in case of a bad offset.
  for (let i = 0; i < Math.max(cadence.every, 6); i += 1) {
    if (trades(following, cadence)) return isoDay(following);
    following += WEEK_MS;
  }
  return null;
}
