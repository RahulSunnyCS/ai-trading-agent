/**
 * The "Portfolio stop" button of the Rotation page's run bar (BL-095): shows the setting that is
 * applied and opens its pop-up.
 */

import { ShieldHalf } from 'lucide-react';
import { useState } from 'react';

import { cn } from '../../lib/cn';
import { type PortfolioStopSetting, buttonLabel, isOn } from '../../lib/portfolioStop';
import { PortfolioStopDialog } from './PortfolioStopDialog';

export function PortfolioStopButton({
  setting,
  onChange,
}: {
  setting: PortfolioStopSetting;
  onChange: (next: PortfolioStopSetting) => void;
}) {
  const [open, setOpen] = useState(false);
  const on = isOn(setting);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        title="Show the lists with a portfolio stop applied. Changes what is shown, not what is recorded."
        className={cn(
          'inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          on
            ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15'
            : 'border-border bg-surface text-muted hover:border-border-strong hover:text-foreground',
        )}
      >
        <ShieldHalf className="h-3.5 w-3.5" aria-hidden="true" />
        {buttonLabel(setting)}
      </button>
      <PortfolioStopDialog
        open={open}
        onOpenChange={setOpen}
        setting={setting}
        onApply={onChange}
      />
    </>
  );
}
