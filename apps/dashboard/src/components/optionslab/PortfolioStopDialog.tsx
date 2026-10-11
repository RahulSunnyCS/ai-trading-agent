/**
 * The portfolio stop's pop-up (BL-092): the stop in rupees (empty or 0 = none) and AlgoTest's
 * three trailing modes, each with only its own fields, and a plain sentence for what the setting
 * will do. Applying changes what the Rotation page shows, never what was recorded or stored.
 */

import { useEffect, useState } from 'react';

import {
  DEFAULT_SETTING,
  MODE_FIELDS,
  MODE_LABEL,
  type PortfolioStopSetting,
  type TrailMode,
  problems,
  summary,
} from '../../lib/portfolioStop';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';
import { SegmentedControl, type SegmentedOption } from '../ui/SegmentedControl';

const MODE_OPTIONS: SegmentedOption<TrailMode>[] = (
  ['none', 'sl', 'lock', 'locktrail'] as const
).map((value) => ({ value, label: MODE_LABEL[value] }));

type FieldKey = 'a' | 'b' | 'x' | 'y';

function Money({
  label,
  value,
  onChange,
  id,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  id: string;
  placeholder?: string;
}) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm text-foreground">
      <span className="w-28 shrink-0 text-xs text-muted">{label}</span>
      <span className="text-muted">₹</span>
      <Input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        className="w-32"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

const FIELD_LABEL: Record<TrailMode, Partial<Record<FieldKey, string>>> = {
  none: {},
  sl: { x: 'Every profit of', y: 'Move the stop' },
  lock: { a: 'When profit reaches', b: 'Lock' },
  locktrail: {
    a: 'When profit reaches',
    b: 'Lock',
    x: 'Then every more',
    y: 'Raise the level',
  },
};

export function PortfolioStopDialog({
  open,
  onOpenChange,
  setting,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  setting: PortfolioStopSetting;
  onApply: (next: PortfolioStopSetting) => void;
}) {
  const [draft, setDraft] = useState<PortfolioStopSetting>(setting);
  const [tried, setTried] = useState(false);
  // A fresh draft each time the dialog opens, from what is applied now.
  useEffect(() => {
    if (open) {
      setDraft(setting);
      setTried(false);
    }
  }, [open, setting]);

  const issues = problems(draft);
  const set = (patch: Partial<PortfolioStopSetting>) => setDraft((d) => ({ ...d, ...patch }));

  function apply() {
    if (issues.length > 0) {
      setTried(true);
      return;
    }
    onApply(draft);
    onOpenChange(false);
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Portfolio stop"
      description="Closes every pick in the basket when the combined P&L reaches the level. Leave it empty, or 0, for no portfolio stop."
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={() => setDraft(DEFAULT_SETTING)}>
            Reset to default
          </Button>
          <Button size="sm" variant="primary" onClick={apply}>
            Apply
          </Button>
        </>
      }
    >
      <Money
        id="pf-stop"
        label="Stop loss"
        value={draft.stop}
        onChange={(stop) => set({ stop })}
        placeholder="No stop"
      />
      <p className="-mt-1 pl-[7.5rem] text-[11px] text-faint">
        For the whole basket, in rupees. Each strategy keeps its own stop.
      </p>

      <div className="space-y-2 pt-1">
        <span className="block text-xs text-muted">Trailing</span>
        <SegmentedControl
          value={draft.mode}
          options={MODE_OPTIONS}
          onChange={(mode) => set({ mode })}
          ariaLabel="Trailing mode"
          size="sm"
        />
        {MODE_FIELDS[draft.mode].map((f) => (
          <Money
            key={f}
            id={`pf-${f}`}
            label={FIELD_LABEL[draft.mode][f] ?? ''}
            value={draft[f]}
            onChange={(v) => set({ [f]: v } as Partial<PortfolioStopSetting>)}
          />
        ))}
      </div>

      <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted" aria-live="polite">
        {summary(draft)}
      </p>
      {tried && issues.length > 0 ? (
        <ul className="space-y-0.5 text-xs text-negative" role="alert">
          {issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      ) : null}
    </Modal>
  );
}
