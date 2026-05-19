import { MarketDataSimulator } from '../market-data-sim';
import type { BrokerFeed } from './types';

/**
 * Return a BrokerFeed for the current environment.
 *
 * SIMULATE=true → MarketDataSimulator (no credentials needed)
 * BROKER=fyers  → FyersFeed (T-09, not yet implemented)
 * BROKER=angelone → AngelOneFeed (T-10, not yet implemented)
 *
 * Throws a descriptive error if an unrecognised BROKER value is set in live mode.
 */
export function createBrokerFeed(): BrokerFeed {
  const simulate = process.env.SIMULATE === 'true';

  if (simulate) {
    return new MarketDataSimulator();
  }

  // Default to 'fyers' when BROKER is unset — matches the project's primary
  // broker target and avoids a confusing "unknown BROKER" error in live mode
  // where a developer simply forgot to set the var.
  const broker = process.env.BROKER ?? 'fyers';

  switch (broker) {
    case 'fyers':
      // T-09 not yet implemented — throw with a clear message so the startup
      // error is actionable rather than a cryptic import failure.
      throw new Error(
        'Fyers adapter (T-09) is not yet implemented. Set SIMULATE=true for development.',
      );
    case 'angelone':
      throw new Error(
        'Angel One adapter (T-10) is not yet implemented. Set SIMULATE=true for development.',
      );
    default:
      throw new Error(
        `Unknown BROKER value: "${broker}". Valid options: fyers, angelone. Set SIMULATE=true for development.`,
      );
  }
}

export type { BrokerFeed } from './types';
