'use client';

import { cn } from '../../../lib/cn';
import { EMPTY, formatInt, formatNumber, formatPct } from '../../../lib/format';
import {
  isInactiveSignalAction,
  lookbackKeys,
  lookbackLabel,
  signalActionTone,
} from '../../../lib/momentumResult';
import type { MomentumLatest } from '../../../types/momentum';
import { Badge } from '../../ui/Badge';
import { InfoTooltip } from '../../ui/InfoTooltip';
import { THead, TRow, Table, Td, Th } from '../../ui/Table';

export type SignalRow = MomentumLatest['rows'][number] & { reason: string };

/** A signal action as a Badge, toned by the one shared map in lib/momentumResult. */
export function SignalActionBadge({ action }: { action: string | null | undefined }) {
  if (!action) return <span className="text-faint">{EMPTY}</span>;
  return (
    <Badge
      tone={signalActionTone(action)}
      className={cn('whitespace-nowrap', isInactiveSignalAction(action) && 'text-faint')}
    >
      {action}
    </Badge>
  );
}

/**
 * This week's ranked signals. The per-lookback returns that produced each rank sit in small
 * secondary columns, shortest lookback first, between the rank score and Held.
 */
export function SignalsTable({ rows }: { rows: SignalRow[] }) {
  const lookbacks = lookbackKeys(rows);
  if (rows.length === 0) return <p className="text-sm text-muted">No signals for this week.</p>;

  return (
    <Table maxHeight={560}>
      <THead>
        <Th align="right">Rank</Th>
        <Th>Asset</Th>
        <Th>Action</Th>
        <Th>Why</Th>
        <Th align="right">
          <span className="inline-flex items-center gap-1">
            Rank score
            <InfoTooltip
              label="About rank score"
              text="Sum of ranks across lookbacks: lower is better"
            />
          </span>
        </Th>
        {lookbacks.map((key) => (
          <Th key={key} align="right" title={`Return over the ${lookbackLabel(key)} lookback`}>
            {lookbackLabel(key)} return
          </Th>
        ))}
        <Th>Held</Th>
      </THead>
      <tbody>
        {rows.map((row) => (
          <TRow key={row.asset}>
            <Td numeric align="right">
              {row.rank === null ? EMPTY : formatInt(row.rank)}
            </Td>
            <Td className={cn(isInactiveSignalAction(row.action) && 'text-muted')}>{row.asset}</Td>
            <Td>
              <SignalActionBadge action={row.action} />
            </Td>
            <Td className="text-muted">{row.reason}</Td>
            <Td numeric align="right">
              {formatNumber(row.score, 2, { trim: true })}
            </Td>
            {lookbacks.map((key) => {
              const value = row.returns?.[key] ?? null;
              return (
                <Td
                  key={key}
                  numeric
                  align="right"
                  className={cn(
                    'text-xs',
                    value === null
                      ? 'text-faint'
                      : value > 0
                        ? 'text-positive'
                        : value < 0
                          ? 'text-negative'
                          : 'text-muted',
                  )}
                >
                  {formatPct(value, 1, { sign: true })}
                </Td>
              );
            })}
            <Td>{row.held ? 'Yes' : 'No'}</Td>
          </TRow>
        ))}
      </tbody>
    </Table>
  );
}
