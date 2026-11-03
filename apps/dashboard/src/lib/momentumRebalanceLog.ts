/**
 * Words for the Trade book's Momentum rebalance log (BL-200). Every figure is the server's
 * (`GET /api/momentum/lots/rebalances`); this file only chooses the words and tones.
 */

import type { Tone } from '../components/ui/Badge';
import type {
  RebalanceBlock,
  RebalanceKiteCheck,
  RebalanceLine,
  RebalanceStatus,
} from '../types/tradeBook';
import { formatDayShort, formatInr, formatInt, formatIstDateTimeShort } from './format';

export const REBALANCE_TONE: Record<RebalanceStatus, Tone> = {
  done: 'positive',
  'partly done': 'warning',
  'waiting for notes': 'info',
  'not done': 'negative',
  'no lot due': 'neutral',
};

const STATUS_LABEL: Record<RebalanceStatus, string> = {
  done: 'Rebalance done',
  'partly done': 'Partly done',
  'waiting for notes': 'Waiting for notes',
  'not done': 'Rebalance not done',
  'no lot due': 'No lot due',
};

export function rebalanceStatusLabel(status: RebalanceStatus): string {
  return STATUS_LABEL[status] ?? status;
}

/** "Week 2 · Fri 23 Oct · Lot 2" ("… · no lot" for a week no lot was due). */
export function rebalanceTitle(block: RebalanceBlock): string {
  const friday = formatDayShort(block.week, { weekday: true });
  return `Week ${block.week_no} · ${friday} · ${block.lot ?? 'no lot'}`;
}

/** What a missed week became: the lot's next due week, where it is rebalanced in full. */
export function foldedLine(block: RebalanceBlock): string | null {
  const to = block.folded_into;
  if (!to) return null;
  const when = `week ${to.week_no} (${formatDayShort(to.week, { weekday: true })})`;
  return to.scheduled
    ? `Folded into ${block.lot}'s next turn, ${when}: it rebalances in full then.`
    : `Folded into ${when}, when ${block.lot} rebalanced in full.`;
}

/** The line's own note beside its shares: why it is not a plain trade. */
export function lineNote(line: RebalanceLine): string | null {
  if (line.status === 'extra') return 'not in the orders';
  if (line.status === 'outside') return 'not in any lot';
  return null;
}

/** "Nothing bought or sold" / "2 stocks in the orders not traded", or null when all were. */
export function notTradedLine(block: RebalanceBlock): string | null {
  if (block.lot === null) return null;
  const none = block.lines.length === 0 ? 'Nothing bought or sold this week.' : '';
  const n = block.not_traded;
  const rest =
    n > 0 ? `${formatInt(n)} ${n === 1 ? 'stock' : 'stocks'} in the orders not traded.` : '';
  return [none, rest].filter(Boolean).join(' ') || null;
}

/** "NAZARA 33 · CUPID 42", or a dash when the lot holds nothing. */
export function holdingLine(block: RebalanceBlock): string {
  if (block.holding_after.length === 0) return 'nothing';
  return block.holding_after.map((h) => `${h.symbol} ${formatInt(h.shares)}`).join(' · ');
}

/**
 * The Kite snapshot against the lots: Kite already shows trades the contract notes have not
 * brought in, so a difference is such a trade or a share no lot owns.
 */
export function kiteCheckLine(check: RebalanceKiteCheck | null): string | null {
  if (!check) return null;
  const when = check.synced_at ? formatIstDateTimeShort(check.synced_at) : 'the last snapshot';
  const cash = check.cash !== null ? ` · free cash ${formatInr(check.cash)}` : '';
  if (check.matches) return `Kite at ${when} holds exactly what the lots hold${cash}.`;
  const diffs = check.differences
    .map((d) => `${d.symbol} Kite ${formatInt(d.kite)}, lots ${formatInt(d.lots)}`)
    .join(' · ');
  return `Kite at ${when} differs from the lots: ${diffs}${cash}.`;
}
