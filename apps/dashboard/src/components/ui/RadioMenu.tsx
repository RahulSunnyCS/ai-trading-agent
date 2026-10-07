'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';

export interface RadioMenuOption {
  value: string;
  label: string;
  /** A figure or note shown right-aligned in the figures face (a CAGR, "no data"). */
  detail?: ReactNode;
  disabled?: boolean;
  /** Native hover text, e.g. why an option is disabled. */
  title?: string | undefined;
}

/**
 * Pick one of a few options from a compact button that opens a menu: for a one-of-N choice that
 * needs more than a label per option (a figure beside each) and too little room for a
 * SegmentedControl, such as the headline benchmark picker. Keyboard and screen-reader behaviour
 * come from Radix's dropdown menu (a radio group of menu items).
 */
export function RadioMenu({
  ariaLabel,
  prefix,
  value,
  valueLabel,
  options,
  onChange,
  heading,
  footer,
  swatchClass,
}: {
  /** The trigger's accessible name, e.g. "Benchmark: Nifty 50. Change benchmark". */
  ariaLabel: string;
  /** Muted text before the value on the trigger ("Benchmark"). */
  prefix?: string;
  /** The checked option; '' for none. */
  value: string;
  /** What the trigger shows for the current choice. */
  valueLabel: string;
  options: readonly RadioMenuOption[];
  onChange: (value: string) => void;
  heading?: string;
  footer?: ReactNode;
  /** A token class for a small swatch before the value (a chart line's colour). */
  swatchClass?: string;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className="inline-flex h-8 items-center gap-2 whitespace-nowrap rounded-lg border border-border-strong bg-surface-2 px-3 text-xs transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {prefix ? <span className="text-muted">{prefix}</span> : null}
          {swatchClass ? (
            <span aria-hidden="true" className={`h-2 w-2 rounded-sm ${swatchClass}`} />
          ) : null}
          <span className="font-semibold text-foreground">{valueLabel}</span>
          <ChevronDown className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 w-72 rounded-lg border border-border-strong bg-surface p-1 shadow-elevated"
        >
          {heading ? (
            <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-faint">
              {heading}
            </DropdownMenu.Label>
          ) : null}
          <DropdownMenu.RadioGroup value={value} onValueChange={onChange}>
            {options.map((option) => (
              <DropdownMenu.RadioItem
                key={option.value}
                value={option.value}
                disabled={option.disabled ?? false}
                title={option.title}
                className="flex h-8 cursor-pointer select-none items-center gap-2 rounded-md px-2.5 text-sm outline-none data-[disabled]:cursor-not-allowed data-[highlighted]:bg-surface-2 data-[disabled]:opacity-50"
              >
                <span className="w-3.5 text-primary">
                  <DropdownMenu.ItemIndicator>
                    <Check className="h-3.5 w-3.5" />
                  </DropdownMenu.ItemIndicator>
                </span>
                <span className="flex-1 truncate text-foreground">{option.label}</span>
                {option.detail !== undefined ? (
                  <span className="metric text-xs text-muted">{option.detail}</span>
                ) : null}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          {footer ? (
            <div className="border-t border-border px-2.5 pb-1 pt-1.5 text-[11px] leading-snug text-faint">
              {footer}
            </div>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
