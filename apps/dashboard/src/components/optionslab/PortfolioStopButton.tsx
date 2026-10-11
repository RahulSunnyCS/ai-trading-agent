/**
 * The "Portfolio stop" button of the Rotation page's run bar (BL-095): shows the setting that is
 * applied and opens its pop-up.
 */

import { ShieldHalf } from 'lucide-react';
import { useState } from 'react';

import { type PortfolioStopSetting, buttonLabel, isOn } from '../../lib/portfolioStop';
import { Button } from '../ui/Button';
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
      <Button
        variant={on ? 'primary' : 'secondary'}
        size="sm"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        title="Show the lists with a portfolio stop applied. Changes what is shown, not what is recorded."
      >
        <ShieldHalf className="h-3.5 w-3.5" aria-hidden="true" />
        {buttonLabel(setting)}
      </Button>
      <PortfolioStopDialog
        open={open}
        onOpenChange={setOpen}
        setting={setting}
        onApply={onChange}
      />
    </>
  );
}
