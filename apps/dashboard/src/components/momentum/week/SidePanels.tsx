'use client';

import { TriangleAlert } from 'lucide-react';

import { formatDay, formatInt, formatIstDateTime } from '../../../lib/format';
import type { AttentionItem } from '../../../lib/momentumWeek';
import type {
  MomentumWeekCard,
  MomentumWeekEdgeName,
  MomentumWeekMessage,
} from '../../../types/momentum';
import { Accordion } from '../../ui/Accordion';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';

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

/** Next week's likely trades: the weakest held names and the strongest not held, by rank. Folded
 * to one line: the sleeve table above already says what trades this Friday. */
export function EdgeNames({ card }: { card: MomentumWeekCard }) {
  const edge = card.edge;
  if (!edge) return null;
  return (
    <Accordion
      defaultOpen={false}
      title="Names at the edge"
      description={
        edge.sleeve
          ? `In ${edge.sleeve}, the next sleeve to trade${edge.on ? ` (${formatDay(edge.on)})` : ''}`
          : 'Likely to move at the next rebalance'
      }
    >
      <div className="-mt-2">
        <EdgeList title="Weakest held" names={edge.weakest_held} />
        <EdgeList title="Strongest not held" names={edge.strongest_not_held} />
      </div>
    </Accordion>
  );
}

/** The headline's message, word for word as sent (or held back). Collapsed to when it was sent: it
 * repeats the orders above it, so it is opened to read it word for word or to re-send it. */
export function TelegramMessage({
  message,
  onResend,
  firstWeek = false,
}: {
  message: MomentumWeekMessage | null;
  onResend: () => void;
  /** The paper start Friday: the cards show every name as a buy, the sent message does not. */
  firstWeek?: boolean;
}) {
  return (
    <Accordion
      defaultOpen={false}
      title="Telegram message"
      description={
        message
          ? `${message.sent ? 'sent' : 'not sent'} ${formatIstDateTime(message.at)} · ${message.run}`
          : 'Nothing recorded for this week yet.'
      }
    >
      {message && firstWeek ? (
        <p className="text-xs text-muted">
          This is the message as it was sent: it lists the model's own changes this week (sells,
          adds, trims), not your first buys, which the cards beside it show. It is a record, so it
          is not rewritten.
        </p>
      ) : null}
      {message ? (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-2/40 p-3 font-mono text-xs leading-relaxed text-foreground">
          {message.title}
          {'\n\n'}
          {message.body}
        </pre>
      ) : null}
      <Button size="sm" variant="ghost" onClick={onResend}>
        Re-send…
      </Button>
    </Accordion>
  );
}
