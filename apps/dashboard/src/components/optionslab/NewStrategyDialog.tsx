'use client';

/**
 * "Start a strategy" (BL-102): the one way to begin a new strategy, from Strategies and baskets
 * and from the Builder. Three templates modelled on the live strategies, a copy of a saved one
 * (starred first), or a blank. Nothing is saved here or by choosing: the Builder opens the result
 * unsaved and nothing is written until Save.
 */

import { useEffect, useMemo, useState } from 'react';

import {
  DEFAULT_TEMPLATE_PREMIUM,
  type StartSpec,
  TEMPLATES,
  type TemplateId,
  UNDERLYINGS,
  templateInfo,
} from '../../lib/legwiseBuilder';
import type { SavedStrategy, Underlying } from '../../types/legwise';
import { Button } from '../ui/Button';
import { Input, Select } from '../ui/Input';
import { Modal } from '../ui/Modal';
import { type RadioCardOption, RadioCards } from '../ui/RadioCards';

type Choice = TemplateId | 'copy' | 'blank';

const COPY_VALUE = 'copy';
const BLANK_VALUE = 'blank';

/**
 * Strategies to copy from: the starred ones first, then the rest, each group by name. A star is
 * kept under the strategy's id (what Correlation names it), which can differ from its file name,
 * so either counts.
 */
export function copyOptions(
  saved: readonly SavedStrategy[],
  starred: ReadonlySet<string>,
): { name: string; starred: boolean }[] {
  const rows = saved
    .map((s) => ({ name: s.name, starred: starred.has(s.strategy.id) || starred.has(s.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...rows.filter((r) => r.starred), ...rows.filter((r) => !r.starred)];
}

/** The premium typed in, as a number; null when it is not a positive amount. */
export function parsePremium(text: string): number | null {
  const n = Number(text.trim());
  return text.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null;
}

export function NewStrategyDialog({
  open,
  onOpenChange,
  saved,
  starred,
  onStart,
  initialUnderlying = 'NIFTY',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  saved: readonly SavedStrategy[];
  /** Names the owner starred; offered first under "Copy". */
  starred: ReadonlySet<string>;
  onStart: (spec: StartSpec) => void;
  initialUnderlying?: Underlying;
}) {
  const [underlying, setUnderlying] = useState<Underlying>(initialUnderlying);
  const [choice, setChoice] = useState<Choice>('short_strangle');
  const [premiumText, setPremiumText] = useState(String(DEFAULT_TEMPLATE_PREMIUM.NIFTY ?? ''));
  const copies = useMemo(() => copyOptions(saved, starred), [saved, starred]);
  const [copyFrom, setCopyFrom] = useState('');

  // Each opening starts afresh, on the index of the strategy in hand: the dialog stays mounted,
  // so its state would otherwise be whatever the first (or last) opening left behind.
  useEffect(() => {
    if (!open) return;
    setUnderlying(initialUnderlying);
    setChoice('short_strangle');
    setPremiumText(String(DEFAULT_TEMPLATE_PREMIUM[initialUnderlying] ?? ''));
    setCopyFrom('');
  }, [open, initialUnderlying]);

  // A copy source that has gone from the list falls back to the first one.
  const copyName = copies.some((c) => c.name === copyFrom) ? copyFrom : (copies[0]?.name ?? '');
  const needsPremium =
    choice !== COPY_VALUE && choice !== BLANK_VALUE && templateInfo(choice).needsPremium;
  const premium = parsePremium(premiumText);

  const options: RadioCardOption[] = [
    ...TEMPLATES.map((t) => ({ value: t.id, label: t.label, description: t.description })),
    {
      value: COPY_VALUE,
      label: 'Copy a saved strategy',
      description:
        copies.length === 0
          ? 'There are no saved strategies to copy yet.'
          : 'Start from one you already have; it is saved under a new name.',
    },
    { value: BLANK_VALUE, label: 'Blank', description: 'Two empty legs; you set everything.' },
  ];

  function changeUnderlying(next: Underlying) {
    setUnderlying(next);
    // The premium's default is per index; another index has none, so the person must say one.
    setPremiumText(String(DEFAULT_TEMPLATE_PREMIUM[next] ?? ''));
  }

  const blocked = (needsPremium && premium === null) || (choice === COPY_VALUE && copyName === '');

  function start() {
    if (blocked) return;
    if (choice === COPY_VALUE) onStart({ kind: 'copy', name: copyName });
    else if (choice === BLANK_VALUE) onStart({ kind: 'blank', underlying });
    else
      onStart({
        kind: 'template',
        id: choice,
        underlying,
        ...(needsPremium && premium !== null ? { premium } : {}),
      });
    onOpenChange(false);
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Start a strategy"
      description="Nothing is saved until you press Save in the Builder."
      className="max-w-lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={blocked} onClick={start}>
            Open in Builder
          </Button>
        </>
      }
    >
      {choice !== COPY_VALUE ? (
        <div className="flex flex-col gap-1 text-xs text-muted">
          Index
          <Select
            value={underlying}
            onChange={(e) => changeUnderlying(e.target.value as Underlying)}
            aria-label="Index"
          >
            {UNDERLYINGS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      <RadioCards
        name="start-choice"
        value={choice}
        options={options}
        onChange={(value) => setChoice(value as Choice)}
      />

      {needsPremium ? (
        <div className="flex flex-col gap-1 text-xs text-muted">
          Premium to sell near (₹)
          <Input
            inputMode="decimal"
            value={premiumText}
            onChange={(e) => setPremiumText(e.target.value)}
            aria-label="Premium"
            aria-invalid={premium === null}
            placeholder={`e.g. ${DEFAULT_TEMPLATE_PREMIUM.NIFTY ?? 65}`}
            className="w-32"
          />
          {premium === null ? (
            <span className="text-negative">Enter the premium in rupees, above 0.</span>
          ) : null}
        </div>
      ) : null}

      {choice === COPY_VALUE && copies.length > 0 ? (
        <div className="flex flex-col gap-1 text-xs text-muted">
          Strategy to copy
          <Select
            value={copyName}
            onChange={(e) => setCopyFrom(e.target.value)}
            aria-label="Strategy to copy"
          >
            {copies.map((c) => (
              <option key={c.name} value={c.name}>
                {c.starred ? '★ ' : ''}
                {c.name}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
    </Modal>
  );
}
