/**
 * "Something is missing, here is the command that fixes it": a plain sentence for the reader,
 * then the command in a code block with a copy button. Replaces CLI text printed inline.
 */

import type { ReactNode } from 'react';

import { cn } from '../../../lib/cn';
import { CodeBlock } from '../../ui/CodeBlock';
import { CopyButton } from '../../ui/CopyButton';

export function CommandHint({
  children,
  command,
  where,
  className,
}: {
  /** What is missing and what the command does, in plain words. */
  children: ReactNode;
  command: string;
  /** Where to run it ("from packages/option-backtesting"). */
  where?: string;
  className?: string;
}) {
  return (
    <div className={cn('space-y-2 text-left text-sm text-muted', className)}>
      <p>{children}</p>
      <div className="flex items-center gap-1.5">
        <CodeBlock className="min-w-0 flex-1">{command}</CodeBlock>
        <CopyButton text={command} label="Copy command" />
      </div>
      {where ? <p className="text-xs text-faint">Run it {where}.</p> : null}
    </div>
  );
}
