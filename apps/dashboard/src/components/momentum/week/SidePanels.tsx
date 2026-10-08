'use client';

import { TriangleAlert } from 'lucide-react';

import { formatDay, formatInt, formatIstDateTime } from '../../../lib/format';
import type { AttentionItem } from '../../../lib/momentumWeek';
import type {
  MomentumWeekCard,
  MomentumWeekEdgeName,
  MomentumWeekMessage,
} from '../../../types/momentum';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';

/** Only what needs a person; the card is not drawn when the list is empty. */
export function NeedsAttention({
  items,
  onAction,
}: {
  items: readonly AttentionItem[];
  onAction: (item: AttentionItem) => void;
}) {
  if (!items.length) return null;
  return (
    <Card flush className="border-warning/40">
      <ul className="divide-y divide-border">
        {items.map((item) => (
          <li key={item.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
            <TriangleAlert
              className={
                item.tone === 'negative' ? 'h-4 w-4 text-negative' : 'h-4 w-4 text-warning'
              }
              aria-hidden="true"
            />
            <span className="text-sm font-semibold text-foreground">{item.title}</span>
            <span className="min-w-0 flex-1 basis-64 text-xs text-muted">{item.detail}</span>
            {item.action ? (
              <Button size="sm" onClick={() => onAction(item)}>
                {item.action.kind === 'review'
                  ? 'Classify…'
                  : item.action.kind === 'run'
                    ? 'Run by hand…'
                    : 'Open Journal'}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** What the final run changed against the 14:40 preview (ETF favourites have a preview). */
export function SincePreview({ card }: { card: MomentumWeekCard }) {
  const diff = card.since_preview;
  if (!diff) return null;
  const changes = diff.added.length + diff.dropped.length;
  return (
    <Card>
      <CardHeader
        title="Since the 14:40 preview"
        description={
          changes
            ? `${formatInt(changes)} change${changes === 1 ? '' : 's'} at the close`
            : 'The final kept every trade the preview had.'
        }
      />
      <ul className="space-y-1.5 text-sm">
        {diff.added.map((item) => (
          <li key={`a-${item.asset}`} className="flex items-center gap-2">
            <Badge tone="info">{item.action}</Badge>
            <span className="font-semibold text-foreground">{item.asset}</span>
            <span className="text-xs text-muted">new at the final</span>
          </li>
        ))}
        {diff.dropped.map((item) => (
          <li key={`d-${item.asset}`} className="flex items-center gap-2">
            <Badge tone="neutral">
              <s>{item.action}</s>
            </Badge>
            <span className="font-semibold text-foreground">{item.asset}</span>
            <span className="text-xs text-muted">was in the preview, not the final</span>
          </li>
        ))}
      </ul>
      {diff.dropped.length ? (
        <p className="mt-2 text-xs text-muted">
          If you traded on the preview, these differ from the model now; the next rebalance sorts
          them out.
        </p>
      ) : null}
    </Card>
  );
}

function EdgeList({ title, names }: { title: string; names: readonly MomentumWeekEdgeName[] }) {
  return (
    <div>
      <div className="px-1 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-faint">
        {title}
      </div>
      {names.length ? (
        <ul>
          {names.map((name) => {
            const delta = name.rank_prev != null ? name.rank_prev - name.rank : null;
            return (
              <li
                key={name.asset}
                className="flex items-center gap-2 border-t border-border px-1 py-1.5 text-sm"
              >
                <span className="w-32 truncate font-semibold text-foreground">{name.asset}</span>
                <span className="metric text-xs text-muted">rank {formatInt(name.rank)}</span>
                {delta ? (
                  <span
                    className={
                      delta > 0 ? 'metric text-xs text-positive' : 'metric text-xs text-negative'
                    }
                  >
                    {delta > 0 ? '▲' : '▼'}
                    {formatInt(Math.abs(delta))}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="px-1 py-1 text-xs text-muted">None ranked.</p>
      )}
    </div>
  );
}

/** Next week's likely trades: the weakest held names and the strongest not held, by rank. */
export function EdgeNames({ card }: { card: MomentumWeekCard }) {
  const edge = card.edge;
  if (!edge) return null;
  return (
    <Card>
      <CardHeader
        title="Names at the edge"
        description={
          edge.sleeve
            ? `In ${edge.sleeve}, the next sleeve to trade${edge.on ? ` (${formatDay(edge.on)})` : ''}`
            : 'Likely to move at the next rebalance'
        }
      />
      <EdgeList title="Weakest held" names={edge.weakest_held} />
      <EdgeList title="Strongest not held" names={edge.strongest_not_held} />
    </Card>
  );
}

/** The headline's message, word for word as sent (or held back). */
export function TelegramMessage({
  message,
  onResend,
}: {
  message: MomentumWeekMessage | null;
  onResend: () => void;
}) {
  return (
    <Card>
      <CardHeader
        title="Telegram message"
        description={
          message
            ? `${message.sent ? 'sent' : 'not sent'} ${formatIstDateTime(message.at)} · ${message.run}`
            : 'Nothing recorded for this week yet.'
        }
        actions={
          <Button size="sm" variant="ghost" onClick={onResend}>
            Re-send…
          </Button>
        }
      />
      {message ? (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-2/40 p-3 font-mono text-xs leading-relaxed text-foreground">
          {message.title}
          {'\n\n'}
          {message.body}
        </pre>
      ) : null}
    </Card>
  );
}
