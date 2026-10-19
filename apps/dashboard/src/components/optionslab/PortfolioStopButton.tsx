/**
 * The "Portfolio stop" button (BL-095): shows the setting that is applied and opens its pop-up.
 * On the Rotation page each list card has its own (Adaptive Classic, Adaptive Tuned), each with
 * its own default level.
 */

import { ShieldHalf } from 'lucide-react';
import { useState } from 'react';

import {
  DEFAULT_SETTING,
  type PortfolioStopSetting,
  buttonLabel,
  isOn,
} from '../../lib/portfolioStop';
import { SEVERAL_LISTS_VISIBLE } from '../../lib/rotationListNames';
import { Button } from '../ui/Button';
import { PortfolioStopDialog } from './PortfolioStopDialog';

export function PortfolioStopButton({
  setting,
  onChange,
  defaults = DEFAULT_SETTING,
  dialogTitle,
}: {
  setting: PortfolioStopSetting;
  onChange: (next: PortfolioStopSetting) => void;
  /** This button's default ("Reset to default" in the pop-up). */
  defaults?: PortfolioStopSetting;
  /** The pop-up's title, e.g. "Portfolio stop · Adaptive Tuned". */
  dialogTitle?: string;
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
        title={`Show ${SEVERAL_LISTS_VISIBLE ? 'the lists' : 'the list'} with a portfolio stop applied. Changes what is shown, not what is recorded.`}
      >
        <ShieldHalf className="h-3.5 w-3.5" aria-hidden="true" />
        {buttonLabel(setting)}
      </Button>
      <PortfolioStopDialog
        open={open}
        onOpenChange={setOpen}
        setting={setting}
        onApply={onChange}
        defaults={defaults}
        {...(dialogTitle ? { title: dialogTitle } : {})}
      />
    </>
  );
}
