'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { KeyboardEvent, ReactNode, Ref } from 'react';

import { cn } from '../../lib/cn';
import { Button } from './Button';

/**
 * A panel that slides over the page from one side (the Analytics page pattern's settings
 * drawer, and the stock drawer on Scores): a title row with the close button, a body that
 * scrolls on its own, and an optional footer that stays put. Built on Radix Dialog, so it
 * traps focus, closes on Esc and returns focus to what opened it.
 */
export function Drawer({
  open,
  onOpenChange,
  title,
  subtitle,
  actions,
  closeLabel = 'Close',
  side = 'right',
  bodyRef,
  onKeyDown,
  footer,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** One line under the title. */
  subtitle?: ReactNode;
  /** Buttons between the title and the close button. */
  actions?: ReactNode;
  closeLabel?: string;
  side?: 'left' | 'right';
  /** The scrolling body, for a caller that scrolls it (revealing a section). */
  bodyRef?: Ref<HTMLDivElement>;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30 data-[state=open]:animate-fade-in" />
        <Dialog.Content
          aria-describedby={undefined}
          onKeyDown={onKeyDown}
          className={cn(
            'fixed inset-y-0 z-50 flex w-full max-w-[30rem] flex-col border-border-strong bg-surface shadow-elevated focus:outline-none data-[state=open]:animate-fade-in',
            side === 'right' ? 'right-0 border-l' : 'left-0 border-r',
          )}
        >
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-sm font-semibold text-foreground">{title}</Dialog.Title>
              {subtitle ? <p className="truncate text-xs text-muted">{subtitle}</p> : null}
            </div>
            {actions}
            <Dialog.Close asChild>
              <Button size="icon" variant="ghost" aria-label={closeLabel}>
                <X className="h-4 w-4" />
              </Button>
            </Dialog.Close>
          </div>
          <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto p-4">
            {children}
          </div>
          {footer}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
