'use client';

import { cn } from '../../../lib/cn';
import { formatDay } from '../../../lib/format';
import type { MomentumConfigChip, MomentumSettingsSection } from '../../../lib/momentumConfig';
import { Badge } from '../../ui/Badge';

/**
 * The form's current settings as chips, straight from `describeConfig`: the one summary of
 * "what the next run tests". Each chip opens the settings accordion that changes it.
 */
export function MomentumSettingsChips({
  datasetLabel,
  chips,
  pricesThrough,
  onOpenSection,
  singleLine = false,
}: {
  datasetLabel: string;
  chips: readonly MomentumConfigChip[];
  /** Last week of price data ("2026-09-25"). */
  pricesThrough: string;
  onOpenSection: (section: MomentumSettingsSection) => void;
  /** One row that clips at the edge (the run bar) instead of wrapping. */
  singleLine?: boolean;
}) {
  return (
    <section
      className={cn(
        'flex items-center gap-1.5',
        // One row that scrolls sideways (touchpad, shift-wheel) rather than wrapping or clipping
        // a chip out of sight.
        singleLine
          ? 'flex-nowrap overflow-x-auto [scrollbar-width:none] [&>*]:shrink-0'
          : 'flex-wrap',
      )}
      aria-label="Current settings"
    >
      {/* In the run bar the dataset switch beside the chips already names it. */}
      {singleLine ? null : <Badge tone="primary">{datasetLabel}</Badge>}
      {chips.map((chip) => (
        <button
          key={chip.id}
          type="button"
          onClick={() => onOpenSection(chip.section)}
          title="Open this setting"
          className="whitespace-nowrap rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-muted transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {chip.label}
        </button>
      ))}
      {/* The headline names the run's last week; the run bar has no room for it. */}
      {singleLine ? null : (
        <span className="whitespace-nowrap px-1 text-xs text-faint">
          prices through {formatDay(pricesThrough)}
        </span>
      )}
    </section>
  );
}
