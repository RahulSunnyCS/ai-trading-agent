/**
 * The Live page's once-a-second clock, kept in this leaf so only it re-renders every second —
 * not the whole page with its charts.
 */

import { useNow } from '../../hooks/useNow';
import { type MarketState, describeMarketSession, marketSession } from '../../lib/market';
import { Badge, type Tone } from '../ui/Badge';
import { StatusDot } from '../ui/StatusDot';

/** The same tones as the top bar's market item (shell/SystemStatus.tsx). */
const MARKET_TONE: Record<MarketState, Tone> = {
  open: 'positive',
  pre_open: 'warning',
  closed: 'neutral',
};

const TICK_MS = 1000;

/** Market session (open / pre-open / closed) and when that changes, in IST. */
export function MarketSessionBadge() {
  const now = useNow(TICK_MS);
  if (now === null) return <Badge tone="neutral">Market session…</Badge>;
  const session = marketSession(now);
  return (
    <Badge tone={MARKET_TONE[session.state]}>
      <StatusDot
        tone={MARKET_TONE[session.state]}
        pulse={session.state === 'open'}
        label={session.label}
      />
      {describeMarketSession(now)} IST
    </Badge>
  );
}
