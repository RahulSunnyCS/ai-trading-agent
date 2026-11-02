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
};

const STATUS_LABEL: Record<RebalanceStatus, string> = {
  done: 'Rebalance done',
  'partly done': 'Partly done',
  'waiting for notes': 'Waiting for notes',
  'not done': 'Rebalance not done',
};

export function rebalanceStatusLabel(status: RebalanceStatus): string {
  return STATUS_LABEL[status] ?? status;
}

/** "Week 2 · Fri 23 Oct · Lot 2" */
export function rebalanceTitle(block: RebalanceBlock): string {
  return `Week ${block.week_no} · ${formatDayShort(block.week, { weekday: true })} · ${block.lot}`;
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
  if (line.status === 'missed') {
    return line.planned_shares
      ? `not traded (${formatInt(line.planned_shares)} planned)`
      : 'not traded';
  }
  if (line.status === 'shares differ' && line.planned_shares !== null) {
    return `${formatInt(line.planned_shares)} planned`;
  }
  if (line.status === 'extra') return 'not in the orders';
  return null;
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
