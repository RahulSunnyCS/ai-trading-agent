/**
 * The Rotation pages' slippage switch: "0.5%" (the default) books every paper figure with each
 * entry and exit filled 0.5% against the trade; "Off" shows them without. One setting for the
 * browser (`store/rotationSlippage.ts`), so Rotation, Matrix, Correlation and the Overview card
 * agree. Display only: the 09:16 picks are ranked without it.
 */

import { SLIPPAGE_HELP, SLIPPAGE_TEXT } from '../../../lib/rotationSlippage';
import { useRotationSlippage, useRotationSlippageStore } from '../../../store/rotationSlippage';
import { InfoTooltip } from '../../ui/InfoTooltip';
import { SegmentedControl, type SegmentedOption } from '../../ui/SegmentedControl';

type Choice = 'on' | 'off';

const OPTIONS: SegmentedOption<Choice>[] = [
  { value: 'on', label: SLIPPAGE_TEXT },
  { value: 'off', label: 'Off' },
];

/** `extra`: a sentence the page adds to the tooltip (what on it the switch does not reach). */
export function SlippageSwitch({ extra }: { extra?: string } = {}) {
  const on = useRotationSlippage();
  const setOn = useRotationSlippageStore((state) => state.setOn);
  return (
    <div className="flex items-center gap-2 text-xs text-muted">
      Slippage
      <SegmentedControl
        value={on ? 'on' : 'off'}
        options={OPTIONS}
        onChange={(choice) => setOn(choice === 'on')}
        ariaLabel="Slippage"
        size="sm"
      />
      <InfoTooltip
        text={extra ? `${SLIPPAGE_HELP} ${extra}` : SLIPPAGE_HELP}
        label="About slippage"
      />
    </div>
  );
}
