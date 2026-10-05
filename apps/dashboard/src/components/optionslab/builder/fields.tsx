/**
 * Form controls for the strategy builder: a captioned field that can carry a tooltip and the
 * validator's messages, and thin typed wrappers over the shared ui inputs.
 */

import type { ReactNode } from 'react';

import { InfoTooltip } from '../../ui/InfoTooltip';
import { Input, Select } from '../../ui/Input';

export type Errors = readonly string[] | undefined;

/** A captioned group of controls, with an optional (i) and the problems found in it. */
export function LabeledField({
  label,
  hint,
  errors,
  children,
}: {
  label: string;
  /** One sentence behind an (i) next to the label. */
  hint?: string | undefined;
  errors?: Errors;
  children: ReactNode;
}) {
  return (
    <fieldset className="min-w-0 text-xs text-muted">
      <legend className="mb-1 flex items-center gap-1">
        {label}
        {hint ? <InfoTooltip text={hint} label={`About ${label}`} /> : null}
      </legend>
      {children}
      <FieldErrors errors={errors} />
    </fieldset>
  );
}

export function FieldErrors({ errors }: { errors?: Errors }) {
  if (!errors || errors.length === 0) return null;
  return (
    <div role="alert" className="mt-1 max-w-xs space-y-0.5">
      {errors.map((message) => (
        <p key={message} className="text-xs text-negative">
          {message}
        </p>
      ))}
    </div>
  );
}

function invalid(errors: Errors): { 'aria-invalid'?: true } {
  return errors && errors.length > 0 ? { 'aria-invalid': true } : {};
}

export function Choice<T extends string>(props: {
  value: T;
  options: readonly (T | { value: T; label: string })[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
  errors?: Errors;
}) {
  return (
    <Select
      value={props.value}
      aria-label={props.label}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.target.value as T)}
      className="w-auto"
      {...invalid(props.errors)}
    >
      {props.options.map((option) => {
        const value = typeof option === 'string' ? option : option.value;
        return (
          <option key={value} value={value}>
            {typeof option === 'string' ? option : option.label}
          </option>
        );
      })}
    </Select>
  );
}

export function TextField(props: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  type?: 'text' | 'time' | 'date';
  className?: string;
  errors?: Errors;
}) {
  return (
    <Input
      type={props.type ?? 'text'}
      value={props.value}
      aria-label={props.label}
      onChange={(event) => props.onChange(event.target.value)}
      className={props.className ?? 'w-auto'}
      {...invalid(props.errors)}
    />
  );
}

/** A number that may be left empty (an unset optional), unlike ui/NumberField. */
export function OptionalNumber(props: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  label: string;
  disabled?: boolean;
  step?: number;
  className?: string;
  errors?: Errors;
}) {
  return (
    <Input
      type="number"
      inputMode="decimal"
      value={props.value ?? ''}
      step={props.step ?? 1}
      aria-label={props.label}
      disabled={props.disabled}
      onChange={(event) =>
        props.onChange(event.target.value === '' ? undefined : Number(event.target.value))
      }
      className={props.className ?? 'w-24'}
      {...invalid(props.errors)}
    />
  );
}
