'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check } from 'lucide-react';
import type { ReactNode } from 'react';

export interface CheckboxMenuOption {
  value: string;
  label: string;
}

/**
 * A button that opens a menu of independent on/off choices, such as which table columns to show.
 * The trigger's content is the caller's (an icon and a word). Keyboard and screen-reader
 * behaviour come from Radix's dropdown menu (checkbox items); the menu stays open while ticking.
 */
export function CheckboxMenu({
  ariaLabel,
  trigger,
  heading,
  options,
  checked,
  onCheckedChange,
}: {
  ariaLabel: string;
  trigger: ReactNode;
  heading?: string;
  options: readonly CheckboxMenuOption[];
  /** The values that are on. */
  checked: ReadonlySet<string>;
  onCheckedChange: (value: string, checked: boolean) => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border-strong bg-surface-2 px-3 text-xs text-foreground transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {trigger}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 w-52 rounded-lg border border-border-strong bg-surface p-1 shadow-elevated"
        >
          {heading ? (
            <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-faint">
              {heading}
            </DropdownMenu.Label>
          ) : null}
          {options.map((option) => (
            <DropdownMenu.CheckboxItem
              key={option.value}
              checked={checked.has(option.value)}
              onCheckedChange={(next) => onCheckedChange(option.value, next === true)}
              onSelect={(event) => event.preventDefault()}
              className="flex h-8 cursor-pointer select-none items-center gap-2 rounded-md px-2.5 text-sm outline-none data-[highlighted]:bg-surface-2"
            >
              <span className="w-3.5 text-primary">
                <DropdownMenu.ItemIndicator>
                  <Check className="h-3.5 w-3.5" />
                </DropdownMenu.ItemIndicator>
              </span>
              <span className="flex-1 truncate text-foreground">{option.label}</span>
            </DropdownMenu.CheckboxItem>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
