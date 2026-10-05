import * as Dialog from '@radix-ui/react-dialog';

import { formatDay } from '../../lib/format';
import type { SuggestionChange } from '../../lib/personalities';
import { Button } from '../ui/Button';

export interface ApproveRequest {
  key: string;
  personalityName: string;
  tradeDate: string;
  changes: SuggestionChange[];
}

/** Confirms an evolution suggestion before it is written to the personality. */
export function ApproveSuggestionDialog({
  request,
  applying,
  onConfirm,
  onClose,
}: {
  request: ApproveRequest | null;
  applying: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const applied = request?.changes.filter((c) => c.applied) ?? [];
  const skipped = request?.changes.filter((c) => !c.applied) ?? [];
  return (
    <Dialog.Root open={request !== null} onOpenChange={(open) => !open && !applying && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-6 shadow-elevated">
          <Dialog.Title className="text-base font-semibold tracking-tight text-foreground">
            Apply this change to {request?.personalityName}?
          </Dialog.Title>
          <Dialog.Description asChild>
            <div className="mt-2 space-y-3 text-sm text-muted">
              <p>Suggested after the {formatDay(request?.tradeDate)} session.</p>
              {applied.length > 0 ? (
                <ul className="space-y-1 rounded-lg border border-border bg-surface-2 px-3 py-2">
                  {applied.map((c) => (
                    <li key={c.key} className="flex justify-between gap-4">
                      <span>{c.label}</span>
                      <span className="metric text-foreground">
                        {c.current} → {c.proposed}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>This suggestion has no change the server can apply.</p>
              )}
              {skipped.length > 0 ? (
                <p className="text-xs">
                  Not applied (the server only writes minimum probability):{' '}
                  {skipped.map((c) => c.label).join(', ')}.
                </p>
              ) : null}
              <p className="text-xs">
                The change is written to the personality and recorded in its audit log.
              </p>
            </div>
          </Dialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <Button onClick={onClose} disabled={applying}>
              Cancel
            </Button>
            <Button variant="primary" loading={applying} onClick={onConfirm}>
              Approve change
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
