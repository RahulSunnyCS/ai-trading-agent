/**
 * PendingSuggestionsCard — the "approval inbox" for evolution-engine proposals.
 *
 * Shows every retrospection_results row where the engine has proposed a
 * parameter adjustment that hasn't yet been applied. The operator can Approve
 * one to commit the change to personality_configs.params via the existing
 * POST /api/retrospection/evolution/apply/:personalityId endpoint.
 *
 * Out of scope for v1: a Reject button (no backend endpoint exists; the next
 * EOD job will overwrite proposed_adjustments anyway when fresher metrics
 * arrive, so unapproved suggestions auto-expire daily).
 */

import { CheckCircle2, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { usePendingSuggestions } from '../hooks/usePendingSuggestions.js';
import { apiPost } from '../lib/api.js';
import type { PendingSuggestion, Personality } from '../types/trading.js';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { StateMessage } from './ui/StateMessage';
import { THead, TRow, Table, Td, Th } from './ui/Table';

interface PendingSuggestionsCardProps {
  /** Used to resolve personality_id → display_name for the row labels. */
  personalities: Personality[];
  /** Called after a successful apply so the personality list refreshes. */
  onApplied: () => void;
}

function formatProposedAdjustments(adj: Record<string, unknown> | null): string {
  if (!adj) return '—';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(adj)) {
    if (typeof v === 'number') {
      // min_probability is a fraction — show as percent for readability.
      parts.push(k === 'min_probability' ? `${k}=${(v * 100).toFixed(0)}%` : `${k}=${v}`);
    } else {
      parts.push(`${k}=${String(v)}`);
    }
  }
  return parts.join(' · ');
}

export function PendingSuggestionsCard({
  personalities,
  onApplied,
}: PendingSuggestionsCardProps) {
  const { suggestions, loading, error, refresh } = usePendingSuggestions();
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string>>({});

  // Fast id→name lookup so a row can render its personality's display name.
  const nameById = new Map(personalities.map((p) => [p.id, p.display_name]));

  async function approve(s: PendingSuggestion) {
    const key = `${s.personality_id}:${s.trade_date}`;
    setApplyingId(key);
    setErrorById((prev) => ({ ...prev, [key]: '' }));
    // See usePendingSuggestions for why this path is not under /api.
    const res = await apiPost<{ data: unknown }>(
      `/retrospection/evolution/apply/${s.personality_id}`,
      { trade_date: s.trade_date },
    );
    setApplyingId(null);
    if (!res.ok) {
      setErrorById((prev) => ({ ...prev, [key]: res.error }));
      return;
    }
    // Refresh both lists: the suggestions row will disappear, and the personality
    // params summary in the parent table will show the newly-applied value.
    refresh();
    onApplied();
  }

  const hasSuggestions = suggestions.length > 0;

  return (
    <Card flush>
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            Pending Evolution Suggestions
          </h2>
          <p className="mt-0.5 text-sm text-muted">
            Parameter changes the evolution engine has proposed — awaiting your approval
          </p>
        </div>
        <Button size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <div className="px-2 py-1">
        {error !== null && (
          <StateMessage
            variant="error"
            title="Couldn't load pending suggestions"
            description={error}
            className="m-3"
          />
        )}
        {!loading && error === null && !hasSuggestions && (
          <StateMessage
            variant="empty"
            title="Nothing waiting for approval"
            description="The EOD retrospection job (runs at 16:00 IST on trading days) populates this list when it proposes parameter changes."
          />
        )}
        {hasSuggestions && (
          <Table>
            <THead>
              <Th>Personality</Th>
              <Th>Trade Date</Th>
              <Th>Regime</Th>
              <Th align="right">Trades</Th>
              <Th align="right">Win Rate</Th>
              <Th>Proposed Change</Th>
              <Th>{''}</Th>
            </THead>
            <tbody>
              {suggestions.map((s) => {
                const key = `${s.personality_id}:${s.trade_date}`;
                const total = Number(s.total_trades);
                const wins = Number(s.winning_trades);
                const winRate = total > 0 ? (wins / total) * 100 : null;
                const rowError = errorById[key];
                return (
                  <TRow key={key}>
                    <Td className="font-medium text-foreground">
                      {nameById.get(s.personality_id) ?? s.personality_id.slice(0, 8)}
                    </Td>
                    <Td className="tabular-nums text-muted">{s.trade_date}</Td>
                    <Td className="text-muted">{s.market_regime ?? '—'}</Td>
                    <Td numeric align="right" className="text-foreground">
                      {total.toLocaleString('en-IN')}
                    </Td>
                    <Td numeric align="right" className="text-foreground">
                      {winRate !== null ? `${winRate.toFixed(0)}%` : '—'}
                    </Td>
                    <Td className="tabular-nums text-foreground">
                      {formatProposedAdjustments(s.proposed_adjustments)}
                    </Td>
                    <Td align="right">
                      <div className="flex flex-col items-end gap-1">
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={applyingId === key}
                          onClick={() => void approve(s)}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          {applyingId === key ? 'Applying…' : 'Approve'}
                        </Button>
                        {rowError ? (
                          <span className="max-w-[12rem] text-right text-[10px] text-negative">
                            {rowError}
                          </span>
                        ) : null}
                      </div>
                    </Td>
                  </TRow>
                );
              })}
            </tbody>
          </Table>
        )}
      </div>
    </Card>
  );
}
