/**
 * PendingSuggestionsCard — the inbox of parameter changes the end-of-day review has proposed.
 *
 * Each suggestion shows Current → Proposed for every proposed key (current from the
 * personality's params) and the evidence it was based on. Approve asks first, then calls
 * POST /retrospection/evolution/apply/:personalityId, which writes min_probability only.
 *
 * There is no Reject: the server has no endpoint for it, so an unapproved suggestion stays
 * in this list.
 */

import { CheckCircle2 } from 'lucide-react';
import { useState } from 'react';

import { usePendingSuggestions } from '../hooks/usePendingSuggestions';
import { apiPost } from '../lib/api';
import { cn } from '../lib/cn';
import { EMPTY, formatDay, formatInt, formatNumber, formatPct, formatPp } from '../lib/format';
import {
  type SuggestionChange,
  serverErrorMessage,
  suggestionChanges,
  suggestionEvidence,
} from '../lib/personalities';
import { regimeBadge } from '../lib/regimeMeta';
import type { PendingSuggestion, Personality } from '../types/trading';
import {
  type ApproveRequest,
  ApproveSuggestionDialog,
} from './personalities/ApproveSuggestionDialog';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { InfoTooltip } from './ui/InfoTooltip';
import { RefreshButton } from './ui/RefreshButton';
import { SkeletonRows } from './ui/Skeleton';
import { StateMessage } from './ui/StateMessage';
import { THead, TRow, Table, Td, Th } from './ui/Table';
import { toast } from './ui/Toast';

interface PendingSuggestionsCardProps {
  /** Every personality (including paused), for names and current values. */
  personalities: readonly Personality[];
  /** Called after a successful apply so the personality list refreshes. */
  onApplied: () => void;
}

function signedTone(value: number | null): string {
  if (value === null || value === 0) return 'text-foreground';
  return value > 0 ? 'text-positive' : 'text-negative';
}

function Evidence({
  label,
  value,
  className,
  hint,
}: {
  label: string;
  value: string;
  className?: string;
  hint?: string;
}) {
  return (
    <div>
      <dt className="flex items-center gap-1 text-xs text-faint">
        {label}
        {hint ? <InfoTooltip text={hint} label={`About ${label}`} /> : null}
      </dt>
      <dd className={cn('metric mt-0.5 text-sm', className ?? 'text-foreground')}>{value}</dd>
    </div>
  );
}

function formatDelta(change: SuggestionChange): string {
  if (change.delta === null) return EMPTY;
  if (change.deltaUnit === 'pp') return formatPp(change.delta, 1, { unit: 'percent' });
  return formatNumber(change.delta, 2, { trim: true, sign: true });
}

function ChangesTable({ changes }: { changes: SuggestionChange[] }) {
  if (changes.length === 0) {
    return <p className="text-sm text-muted">No parameter change was attached.</p>;
  }
  return (
    <Table>
      <THead>
        <Th>Parameter</Th>
        <Th align="right">Current</Th>
        <Th align="right">Proposed</Th>
        <Th align="right">Change</Th>
      </THead>
      <tbody>
        {changes.map((c) => (
          <TRow key={c.key}>
            <Td className="text-muted">
              {c.label}
              {c.applied ? null : (
                <span className="ml-1.5 text-xs text-faint">(not applied by Approve)</span>
              )}
            </Td>
            <Td numeric align="right" className="text-muted">
              {c.current}
            </Td>
            <Td numeric align="right" className="font-medium text-foreground">
              {c.proposed}
            </Td>
            <Td numeric align="right" className="text-muted">
              {formatDelta(c)}
            </Td>
          </TRow>
        ))}
      </tbody>
    </Table>
  );
}

function suggestionKey(s: PendingSuggestion, tradeDate: string): string {
  return `${s.personality_id}:${tradeDate}`;
}

export function PendingSuggestionsCard({ personalities, onApplied }: PendingSuggestionsCardProps) {
  const { suggestions, loading, error, refresh } = usePendingSuggestions();
  const [confirming, setConfirming] = useState<(ApproveRequest & { personalityId: string }) | null>(
    null,
  );
  const [applying, setApplying] = useState(false);

  const byId = new Map(personalities.map((p) => [p.id, p]));

  async function approve() {
    if (confirming === null) return;
    const { personalityId, personalityName, tradeDate, changes } = confirming;
    setApplying(true);
    // See usePendingSuggestions for why this path is not under /api.
    const res = await apiPost<unknown>(`/retrospection/evolution/apply/${personalityId}`, {
      trade_date: tradeDate,
    });
    setApplying(false);
    setConfirming(null);
    if (!res.ok) {
      toast(
        `Couldn't apply the change to ${personalityName}: ${serverErrorMessage(res.error)}`,
        'error',
      );
      return;
    }
    const summary = changes
      .filter((c) => c.applied)
      .map((c) => `${c.label} ${c.current} → ${c.proposed}`)
      .join(', ');
    toast(`Applied to ${personalityName}${summary ? `: ${summary}` : ''}`);
    refresh();
    onApplied();
  }

  const hasSuggestions = suggestions.length > 0;

  return (
    <Card flush>
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="flex items-center gap-1.5 text-base font-semibold tracking-tight text-foreground">
            Suggested changes
            {hasSuggestions ? (
              <Badge status="attention">{formatInt(suggestions.length)}</Badge>
            ) : null}
          </h2>
          <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted">
            Parameter changes proposed by the end-of-day review, waiting for your approval.
            <InfoTooltip
              label="About rejecting a suggestion"
              text="There is no Reject yet: the trading server has no endpoint for it, so a suggestion you don't approve stays in this list."
            />
          </p>
        </div>
        <RefreshButton onClick={refresh} loading={loading} />
      </div>

      <div className="px-5 py-4">
        {loading && !hasSuggestions && error === null && <SkeletonRows rows={2} />}
        {error !== null && (
          <StateMessage
            variant="error"
            title="Couldn't load suggested changes"
            description={error}
          />
        )}
        {!loading && error === null && !hasSuggestions && (
          <StateMessage
            variant="empty"
            title="Nothing waiting for approval"
            description="The end-of-day review (16:00 IST on trading days) adds a suggestion here when it proposes a parameter change."
            className="py-8"
          />
        )}
        {hasSuggestions && (
          <ul className="space-y-3">
            {suggestions.map((s) => {
              const evidence = suggestionEvidence(s);
              const key = suggestionKey(s, evidence.tradeDate);
              const personality = byId.get(s.personality_id);
              const name =
                personality?.display_name ?? `Personality ${s.personality_id.slice(0, 8)}`;
              const changes = suggestionChanges(
                s.proposed_adjustments,
                personality?.params ?? null,
              );
              const regime = regimeBadge(s.market_regime);
              return (
                <li key={key} className="rounded-lg border border-border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{name}</span>
                      <span className="text-xs text-faint">{formatDay(evidence.tradeDate)}</span>
                      <span title={regime.title}>
                        <Badge tone={regime.tone}>{regime.text}</Badge>
                      </span>
                    </div>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={personality?.is_frozen === true}
                      onClick={() =>
                        setConfirming({
                          key,
                          personalityId: s.personality_id,
                          personalityName: name,
                          tradeDate: evidence.tradeDate,
                          changes,
                        })
                      }
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Approve…
                    </Button>
                  </div>

                  <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Evidence label="Trades" value={formatInt(evidence.trades)} />
                    <Evidence label="Win rate" value={formatPct(evidence.winRate, 0)} />
                    <Evidence
                      label="P&L"
                      value={formatPct(evidence.pnlPct, 2, { unit: 'percent', sign: true })}
                      className={signedTone(evidence.pnlPct)}
                      hint="The day's summed P&L % across this personality's closed trades."
                    />
                    <Evidence
                      label="Beat Clockwork Δ"
                      value={formatPp(evidence.beatClockwork, 2, { unit: 'percent' })}
                      className={signedTone(evidence.beatClockwork)}
                      hint="This personality's P&L % minus Clockwork's for the same day and regime. Positive means it beat the benchmark."
                    />
                  </dl>

                  <div className="mt-3">
                    <ChangesTable changes={changes} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ApproveSuggestionDialog
        request={confirming}
        applying={applying}
        onConfirm={() => void approve()}
        onClose={() => setConfirming(null)}
      />
    </Card>
  );
}
