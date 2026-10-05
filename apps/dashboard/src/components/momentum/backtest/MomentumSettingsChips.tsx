'use client';

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
}: {
  datasetLabel: string;
  chips: readonly MomentumConfigChip[];
  /** Last week of price data ("2026-09-25"). */
  pricesThrough: string;
  onOpenSection: (section: MomentumSettingsSection) => void;
}) {
  return (
    <section className="flex flex-wrap items-center gap-1.5" aria-label="Current settings">
      <Badge tone="primary">{datasetLabel}</Badge>
      {chips.map((chip) => (
        <button
          key={chip.id}
          type="button"
          onClick={() => onOpenSection(chip.section)}
          title="Open this setting"
          className="rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-muted transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {chip.label}
        </button>
      ))}
      <span className="px-1 text-xs text-faint">prices through {formatDay(pricesThrough)}</span>
    </section>
  );
}
