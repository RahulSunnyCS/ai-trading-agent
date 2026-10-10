/**
 * The three stock universes a Broad Momentum run can rank (BL-029, BL-036 Phase 1).
 *
 * A leaf module on purpose: `momentumConfig.ts`, `momentumCompare.ts`, `momentumSaved.ts` and the
 * settings panel all name the universe, and none of them may import another.
 */

export type BroadUniverse = 'turnover_rank' | 'total_market' | 'all_liquid';

export interface BroadUniverseInfo {
  /** The settings card and the Saved runs differences table. */
  label: string;
  /** Chips, the result title and the Saved runs tag. */
  short: string;
  description: string;
}

export const BROAD_UNIVERSES: Record<BroadUniverse, BroadUniverseInfo> = {
  turnover_rank: {
    label: 'As each year saw it',
    short: 'Point in time',
    description:
      "each year's 750 most-traded stocks, ranked on the six months before that year began, delisted names included. The tradability filter is always on. Categories are still today's themes.",
  },
  total_market: {
    label: "Today's index list (survivors only)",
    short: "Today's list",
    description:
      "NSE's Total Market index as it is today, applied to every year. A stock that later fell out of the index or was delisted is never bought, so the result flatters. Category ranking covers all of them.",
  },
  all_liquid: {
    label: 'Whole NSE market (liquid only)',
    short: 'Whole NSE market',
    description:
      'every listed NSE equity, narrowed each week to the ones you could really trade. Only stocks with a category tag can be picked in category mode, so "Rank stocks directly" uses it fully.',
  },
};

/** The order the settings cards show them in: the honest one first. */
export const BROAD_UNIVERSE_ORDER: BroadUniverse[] = [
  'turnover_rank',
  'total_market',
  'all_liquid',
];

/**
 * A run's universe. A config with no value (an old saved run) or an unknown one is Total Market:
 * that is what the request model does, and the dashboard's own default is sent explicitly.
 */
export function broadUniverse(config: Record<string, unknown>): BroadUniverse {
  const value = config.broad_universe;
  return value === 'turnover_rank' || value === 'all_liquid' ? value : 'total_market';
}

/** Universes that are only meaningful behind the tradability filter, so it is always on. */
export function isGatedUniverse(universe: BroadUniverse): boolean {
  return universe === 'turnover_rank' || universe === 'all_liquid';
}
