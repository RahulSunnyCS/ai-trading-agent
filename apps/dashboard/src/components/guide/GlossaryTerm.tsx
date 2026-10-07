import * as Tooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

import type { GlossaryEntry } from '../../guide/glossary';
import { glossaryHref, isPlainClick, openGlossaryTerm } from './links';

/**
 * A glossary term inside a guide page: dotted underline, its short definition on hover or
 * focus (the same Radix tooltip as InfoTooltip), and a click opens its Glossary entry.
 */
export function GlossaryTerm({ entry, children }: { entry: GlossaryEntry; children: ReactNode }) {
  return (
    <Tooltip.Provider delayDuration={150}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <a
            href={glossaryHref(entry.id)}
            className="cursor-help text-foreground underline decoration-faint decoration-dotted underline-offset-4 hover:decoration-primary"
            onClick={(event) => {
              if (!isPlainClick(event)) return;
              event.preventDefault();
              openGlossaryTerm(entry.id);
            }}
          >
            {children}
          </a>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            align="start"
            sideOffset={6}
            collisionPadding={12}
            className="z-50 max-w-xs rounded-lg border border-border bg-surface p-3 text-xs leading-relaxed text-muted shadow-elevated data-[state=delayed-open]:animate-fade-in"
          >
            <span className="mb-1 block font-semibold text-foreground">{entry.term}</span>
            {entry.short}
            <Tooltip.Arrow className="fill-border" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
