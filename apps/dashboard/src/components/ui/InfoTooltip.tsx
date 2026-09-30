import * as Tooltip from '@radix-ui/react-tooltip';
import { Info } from 'lucide-react';

/**
 * Small "(i)" icon that reveals a one- or two-sentence explanation on hover /
 * focus. Use next to a setting label whose name alone doesn't say what it
 * does (e.g. "Buffer" vs "Fixed slots") — the whole point is the reader never
 * has to guess or go hunting in docs.
 */
export function InfoTooltip({ text }: { text: string }) {
  return (
    <Tooltip.Provider delayDuration={150}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            aria-label="What does this mean?"
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-faint transition-colors hover:bg-surface-2 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            align="start"
            sideOffset={6}
            collisionPadding={12}
            className="z-50 max-w-xs rounded-lg border border-border bg-surface p-3 text-xs leading-relaxed text-muted shadow-elevated data-[state=delayed-open]:animate-fade-in"
          >
            {text}
            <Tooltip.Arrow className="fill-border" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
