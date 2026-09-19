import * as Tooltip from '@radix-ui/react-tooltip';
import { Info } from 'lucide-react';

/**
 * Info icon that reveals a tab's "what's still pending to complete" checklist
 * on hover (and on keyboard focus). Items are shown as an ordered list, one
 * line each, in the order provided. Renders nothing when there is nothing
 * pending.
 */
export function PendingInfo({
  items,
  title = 'Pending in this tab',
}: { items: string[]; title?: string }) {
  if (items.length === 0) return null;

  return (
    <Tooltip.Provider delayDuration={120}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            aria-label={title}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-faint transition-colors hover:bg-surface-2 hover:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Info className="h-4 w-4" />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="bottom"
            align="start"
            sideOffset={6}
            collisionPadding={12}
            className="z-50 max-w-xs rounded-lg border border-border bg-surface p-3 text-sm shadow-elevated data-[state=delayed-open]:animate-fade-in"
          >
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-faint">
              {title}
            </p>
            <ol className="list-decimal space-y-1 pl-4 text-muted marker:text-faint">
              {items.map((item) => (
                <li key={item} className="leading-snug">
                  {item}
                </li>
              ))}
            </ol>
            <Tooltip.Arrow className="fill-border" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
