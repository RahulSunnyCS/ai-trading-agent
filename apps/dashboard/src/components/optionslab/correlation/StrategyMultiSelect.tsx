'use client';

import { useMemo, useState } from 'react';

import { Input } from '../../ui/Input';
import { StarToggle } from '../../ui/StarToggle';

interface Option {
  name: string;
  kind: string;
  stale?: boolean | undefined;
}

/** A rotation list a comparison can include: its selector (`list:A`) and its display name. */
export interface ListOption {
  selector: string;
  name: string;
}

interface Props {
  options: readonly Option[];
  /** The rotation lists on offer (BL-102); shown above the strategies. */
  lists?: readonly ListOption[];
  chosen: readonly string[];
  onChange: (names: string[]) => void;
  /** Selectors (`list:A` or a strategy name) the owner has starred. */
  starred?: ReadonlySet<string>;
  /** Star or un-star a selector. Omit to hide the stars. */
  onToggleStar?: ((selector: string) => void) | undefined;
}

const SHOWN = 60;

/**
 * The comparison's members (BL-094, BL-102): the rotation lists first (Steady, Calendar,
 * Adaptive and the rest), then any strategy that has results, ticked in or out. The strategy list
 * is the API's enumeration, so a strategy created tomorrow appears here with no change; a text box
 * narrows both (`N_wide`, `dir`, `0932`, `steady`). Stale results are listed but cannot be
 * ticked. A star marks a favourite: starred items are what the page opens on.
 */
export function StrategyMultiSelect({
  options,
  lists = [],
  chosen,
  onChange,
  starred,
  onToggleStar,
}: Props) {
  const [text, setText] = useState('');
  const picked = useMemo(() => new Set(chosen), [chosen]);
  const needle = text.trim().toLowerCase();
  const listMatches = useMemo(
    () =>
      lists.filter(
        (l) =>
          !needle ||
          l.name.toLowerCase().includes(needle) ||
          l.selector.toLowerCase().includes(needle),
      ),
    [lists, needle],
  );
  const matches = useMemo(
    () => options.filter((o) => !needle || o.name.toLowerCase().includes(needle)),
    [options, needle],
  );
  const shown = matches.slice(0, SHOWN);
  const stars = onToggleStar !== undefined;

  function toggle(name: string) {
    onChange(picked.has(name) ? chosen.filter((n) => n !== name) : [...chosen, name]);
  }

  return (
    <div className="flex flex-col gap-2 text-xs text-muted">
      <span>
        To compare ({chosen.length} chosen of {options.length + lists.length})
      </span>
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Filter the list: steady, N_wide, dir, 0932…"
        aria-label="Filter strategies"
      />
      <ul
        className="max-h-60 overflow-y-auto rounded-md border border-border bg-surface p-1"
        aria-label="Lists and strategies"
      >
        {listMatches.length > 0 ? (
          <li className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-faint">
            Lists
          </li>
        ) : null}
        {listMatches.map((l) => (
          <li key={l.selector} className="flex items-center gap-1 rounded px-2 hover:bg-surface-2">
            <label className="flex flex-1 cursor-pointer items-center gap-2 py-1">
              <input
                type="checkbox"
                checked={picked.has(l.selector)}
                onChange={() => toggle(l.selector)}
                aria-label={l.name}
              />
              <span className="text-foreground">{l.name}</span>
            </label>
            {stars ? (
              <StarToggle
                on={starred?.has(l.selector) ?? false}
                label={l.name}
                onClick={() => onToggleStar?.(l.selector)}
              />
            ) : null}
          </li>
        ))}
        {shown.length > 0 ? (
          <li className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-faint">
            Strategies
          </li>
        ) : null}
        {shown.map((o) => (
          <li key={o.name} className="flex items-center gap-1 rounded px-2 hover:bg-surface-2">
            <label className="flex flex-1 cursor-pointer items-center gap-2 py-1">
              <input
                type="checkbox"
                checked={picked.has(o.name)}
                disabled={o.stale && !picked.has(o.name)}
                onChange={() => toggle(o.name)}
                aria-label={o.name}
              />
              <span className="font-mono text-foreground">{o.name}</span>
              {o.kind === 'legwise' ? <span className="text-faint">live</span> : null}
              {o.stale ? <span className="text-warning">older version</span> : null}
            </label>
            {stars ? (
              <StarToggle
                on={starred?.has(o.name) ?? false}
                label={o.name}
                onClick={() => onToggleStar?.(o.name)}
              />
            ) : null}
          </li>
        ))}
        {matches.length === 0 && listMatches.length === 0 ? (
          <li className="px-2 py-1">No list or strategy matches.</li>
        ) : null}
        {matches.length > shown.length ? (
          <li className="px-2 py-1 text-faint">
            {matches.length - shown.length} more: type to narrow the list.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
