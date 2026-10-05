import * as Dialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

import { Button } from '../../ui/Button';

export interface ConfirmRequest {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  /** Styles the confirm button as destructive (discarding edits, overwriting a file). */
  danger?: boolean;
  onConfirm: () => void;
}

/** Asks before an action that loses work. Cancel and Escape leave everything as it was. */
export function ConfirmDialog({
  request,
  onClose,
}: {
  request: ConfirmRequest | null;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open={request !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-6 shadow-elevated">
          <Dialog.Title className="text-base font-semibold tracking-tight text-foreground">
            {request?.title}
          </Dialog.Title>
          <Dialog.Description asChild>
            <div className="mt-2 text-sm text-muted">{request?.body}</div>
          </Dialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant={request?.danger ? 'danger' : 'primary'}
              onClick={() => {
                request?.onConfirm();
                onClose();
              }}
            >
              {request?.confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
