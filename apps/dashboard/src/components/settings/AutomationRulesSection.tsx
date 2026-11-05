'use client';

import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';

import { useDayTypes } from '../../hooks/useDayTypes';
import {
  type AutomationSettings,
  DTE_LABELS,
  type DayRule,
  type DayType,
  INDICES,
  LIST_LABEL,
  type List,
  MAX_RULES,
  ROWS,
  type RowKey,
  WEEKDAYS,
  addRule,
  moveRule,
  removeRule,
  resolveRows,
  rowLabel,
  ruleSentence,
  ruleWhenOfKind,
  rulesProblems,
  updateRule,
} from '../../lib/automation';
import { formatDay } from '../../lib/format';
import { Accordion } from '../ui/Accordion';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Input, Select } from '../ui/Input';

const LISTS: List[] = ['none', 'core', 't1'];

/**
 * Advanced rules (BL-211): on a kind of day an account row trades another list. Each rule names a
 * row, a condition (one index's weekdays to expiry, or the weekday) and a list; they are tried
 * from the top and the first that matches a row decides it. Below them, what each row trades
 * today and tomorrow under the draft, so a rule can be checked before it is saved.
 */
export function AutomationRulesSection({
  draft,
  disabled,
  onChange,
}: {
  draft: AutomationSettings;
  disabled: boolean;
  onChange: (next: AutomationSettings) => void;
}) {
  const days = useDayTypes();
  const problems = rulesProblems(draft.rules);
  const count = draft.rules.length;
  return (
    <section aria-label="Advanced rules">
      <Accordion
        title="Advanced rules"
        defaultOpen={count > 0}
        badge={
          <Badge tone={count ? 'accent' : 'neutral'}>
            {count === 1 ? '1 rule' : `${count} rules`}
          </Badge>
        }
        description="Another list on some days"
      >
        <p className="text-xs text-muted">
          A rule changes which list an account trades on a kind of day. Rules are tried from the
          top; the first one that matches a row decides it, and a row no rule matches trades its own
          list. Days to expiry are weekdays, as in the 09:16 message. A rule that gives a row a list
          it has none of also uploads it, so the row's login must be on.
        </p>
        <ol className="space-y-3">
          {draft.rules.map((rule, i) => (
            <RuleRow
              // The position is the rule's identity: they are an ordered list with no id.
              // biome-ignore lint/suspicious/noArrayIndexKey: ordered rules have no other key
              key={i}
              index={i}
              rule={rule}
              draft={draft}
              disabled={disabled}
              last={i === count - 1}
              onChange={onChange}
            />
          ))}
        </ol>
        {problems.length ? (
          <ul className="space-y-1 text-xs text-negative" role="alert">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={disabled || count >= MAX_RULES}
          onClick={() => onChange(addRule(draft))}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add a rule
        </Button>
        {count ? <WhatTrades draft={draft} days={days} /> : null}
      </Accordion>
    </section>
  );
}

function RuleRow({
  index,
  rule,
  draft,
  disabled,
  last,
  onChange,
}: {
  index: number;
  rule: DayRule;
  draft: AutomationSettings;
  disabled: boolean;
  last: boolean;
  onChange: (next: AutomationSettings) => void;
}) {
  const n = index + 1;
  const set = (change: Partial<DayRule>) => onChange(updateRule(draft, index, change));
  return (
    <li className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-5 font-mono text-xs text-muted">{n}</span>
        <Select
          aria-label={`Rule ${n} account`}
          className="w-auto"
          value={rule.row}
          disabled={disabled}
          onChange={(e) => set({ row: e.target.value as RowKey })}
        >
          {ROWS.map((r) => (
            <option key={r.key} value={r.key}>
              {rowLabel(r.key)}
            </option>
          ))}
        </Select>
        <Select
          aria-label={`Rule ${n} condition`}
          className="w-auto"
          value={rule.when.kind}
          disabled={disabled}
          onChange={(e) => set({ when: ruleWhenOfKind(e.target.value as DayRule['when']['kind']) })}
        >
          <option value="dte">days to expiry</option>
          <option value="weekday">weekday</option>
        </Select>
        {rule.when.kind === 'dte' ? (
          <>
            <Select
              aria-label={`Rule ${n} index`}
              className="w-auto"
              value={rule.when.index}
              disabled={disabled}
              onChange={(e) =>
                set({ when: { ...rule.when, index: e.target.value } as DayRule['when'] })
              }
            >
              {INDICES.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
            <span className="text-xs text-muted">is</span>
            <Select
              aria-label={`Rule ${n} days to expiry`}
              className="w-auto"
              value={rule.when.dte}
              disabled={disabled}
              onChange={(e) =>
                set({ when: { ...rule.when, dte: e.target.value } as DayRule['when'] })
              }
            >
              {DTE_LABELS.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
          </>
        ) : (
          <Select
            aria-label={`Rule ${n} weekday`}
            className="w-auto"
            value={rule.when.weekday}
            disabled={disabled}
            onChange={(e) =>
              set({
                when: { kind: 'weekday', weekday: e.target.value as (typeof WEEKDAYS)[number] },
              })
            }
          >
            {WEEKDAYS.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </Select>
        )}
        <span className="text-xs text-muted">trade</span>
        <Select
          aria-label={`Rule ${n} list`}
          className="w-auto"
          value={rule.list}
          disabled={disabled}
          onChange={(e) => set({ list: e.target.value as List })}
        >
          {LISTS.map((l) => (
            <option key={l} value={l}>
              {LIST_LABEL[l]}
            </option>
          ))}
        </Select>
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Move rule ${n} up`}
            disabled={disabled || index === 0}
            onClick={() => onChange(moveRule(draft, index, -1))}
          >
            <ArrowUp className="h-3.5 w-3.5" aria-hidden />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Move rule ${n} down`}
            disabled={disabled || last}
            onClick={() => onChange(moveRule(draft, index, 1))}
          >
            <ArrowDown className="h-3.5 w-3.5" aria-hidden />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Remove rule ${n}`}
            disabled={disabled}
            onClick={() => onChange(removeRule(draft, index))}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">{ruleSentence(rule, draft)}</p>
      <Input
        aria-label={`Rule ${n} note`}
        className="mt-2"
        placeholder="Why (optional)"
        maxLength={120}
        value={rule.note ?? ''}
        disabled={disabled}
        onChange={(e) => set({ note: e.target.value })}
      />
    </li>
  );
}

function WhatTrades({
  draft,
  days,
}: {
  draft: AutomationSettings;
  days: ReturnType<typeof useDayTypes>;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface-2/50 p-3" aria-label="What trades">
      <p className="mb-2 text-sm font-semibold text-foreground">What trades</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Session label="Today" dayType={days.today} draft={draft} />
        <Session label="Tomorrow" dayType={days.tomorrow} draft={draft} />
      </div>
      {days.errors.length ? (
        <p className="mt-2 text-xs text-warning">{days.errors.join(' · ')}</p>
      ) : null}
      <p className="mt-2 text-xs text-muted">
        The draft's rules against each session's days to expiry, from the same source as the 09:16
        message. Save to make the jobs follow them from their next run.
      </p>
    </div>
  );
}

function Session({
  label,
  dayType,
  draft,
}: {
  label: string;
  dayType: DayType | null;
  draft: AutomationSettings;
}) {
  if (!dayType) {
    return (
      <div>
        <p className="text-xs font-semibold text-foreground">{label}</p>
        <p className="text-xs text-muted">Day type not known yet.</p>
      </div>
    );
  }
  const resolved = resolveRows(draft, dayType);
  return (
    <div>
      <p className="text-xs font-semibold text-foreground">
        {label} · {dayType.weekday} {formatDay(dayType.day)}
        <span className="ml-2 font-mono font-normal text-muted">
          NIFTY {dayType.dte.NIFTY} · SENSEX {dayType.dte.SENSEX}
        </span>
      </p>
      <ul className="mt-1 text-xs">
        {ROWS.map(({ key }) => {
          const r = resolved[key];
          return (
            <li
              key={key}
              className="flex items-center justify-between gap-2 border-b border-dashed border-border py-1 last:border-0"
            >
              <span className="text-muted">{rowLabel(key)}</span>
              <span className="whitespace-nowrap font-medium text-foreground">
                {LIST_LABEL[r.list]}
                {r.rule ? (
                  <Badge tone="accent" className="ml-1.5">
                    rule {r.rule}
                  </Badge>
                ) : null}
                {r.unknown ? (
                  <Badge tone="warning" className="ml-1.5">
                    {r.unknown}
                  </Badge>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
