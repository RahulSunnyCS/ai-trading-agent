'use client';

import * as Switch from '@radix-ui/react-switch';
import { type ReactNode, useId } from 'react';

/** An on/off setting: label and helper text on the left, the switch on the right. */
export function SettingSwitch({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
        </label>
        {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
      </div>
      <Switch.Root
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        className="relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-border-strong transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60 data-[state=checked]:bg-primary"
      >
        <Switch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-surface shadow-card transition-transform data-[state=checked]:translate-x-[18px]" />
      </Switch.Root>
    </div>
  );
}

/** A labelled control row for the settings cards: label + helper on the left, control on the right. */
export function SettingRow({
  label,
  description,
  htmlFor,
  children,
}: {
  label: string;
  description?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-sm font-medium text-foreground">
            {label}
          </label>
        ) : (
          <div className="text-sm font-medium text-foreground">{label}</div>
        )}
        {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
