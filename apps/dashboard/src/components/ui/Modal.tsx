'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { Button } from './Button';

/**
 * A small centred dialog for a short form: a title row with the close button, a body, and an
 * optional footer. Same Radix base as `Drawer` (focus trap, Esc, focus returns to the opener);
 * use the Drawer when the content is long enough to scroll.
 */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  closeLabel = 'Close',
  footer,
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** One or two sentences under the title; also what assistive tech reads as the description. */
  description?: ReactNode;
  closeLabel?: string;
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 data-[state=open]:animate-fade-in" />
        <Dialog.Content
          {...(description ? {} : { 'aria-describedby': undefined })}
          className={cn(
            // Centred by margins, not a translate: the fade-in animation's transform (fill: both)
            // would replace a translate and leave the dialog off centre.
            'fixed inset-0 z-50 m-auto h-fit max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-md overflow-y-auto',
            'rounded-xl border border-border-strong bg-surface shadow-elevated focus:outline-none data-[state=open]:animate-fade-in',
            className,
          )}
        >
          <div className="flex items-start gap-2 border-b border-border px-4 py-3">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-sm font-semibold text-foreground">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-0.5 text-xs text-muted">
                  {description}
                </Dialog.Description>
              ) : null}
            </div>
            <Dialog.Close asChild>
              <Button size="icon" variant="ghost" aria-label={closeLabel}>
                <X className="h-4 w-4" />
              </Button>
            </Dialog.Close>
          </div>
          <div className="space-y-3 p-4">{children}</div>
          {footer ? (
            <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
              {footer}
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
