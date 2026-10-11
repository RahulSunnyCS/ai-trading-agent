'use client';

import { useMemo, useState } from 'react';

import { Input } from '../../ui/Input';

interface Option {
  name: string;
  kind: string;
  stale?: boolean | undefined;
}

interface Props {
  options: readonly Option[];
  chosen: readonly string[];
  onChange: (names: string[]) => void;
}

const SHOWN = 60;

/**
 * Any strategy that has results, ticked in or out of the comparison (BL-094). The list is the
 * API's enumeration, so a strategy created tomorrow appears here with no change; a text box
 * narrows it (`N_wide`, `dir`, `0932`). Stale results are listed but cannot be ticked.
 */
export function StrategyMultiSelect({ options, chosen, onChange }: Props) {
  const [text, setText] = useState('');
  const picked = useMemo(() => new Set(chosen), [chosen]);
  const matches = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return options.filter((o) => !needle || o.name.toLowerCase().includes(needle));
  }, [options, text]);
  const shown = matches.slice(0, SHOWN);

  function toggle(name: string) {
    onChange(picked.has(name) ? chosen.filter((n) => n !== name) : [...chosen, name]);
  }

  return (
    <div className="flex flex-col gap-2 text-xs text-muted">
      <span>
        Strategies to compare ({chosen.length} chosen of {options.length})
      </span>
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Filter the list: N_wide, dir, 0932…"
        aria-label="Filter strategies"
      />
      <ul
        className="max-h-52 overflow-y-auto rounded-md border border-border bg-surface p-1"
        aria-label="Strategies"
      >
        {shown.map((o) => (
          <li key={o.name}>
            <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-surface-2">
              <input
                type="checkbox"
                checked={picked.has(o.name)}
                disabled={o.stale && !picked.has(o.name)}
                onChange={() => toggle(o.name)}
              />
              <span className="font-mono text-foreground">{o.name}</span>
              {o.kind === 'legwise' ? <span className="text-faint">live</span> : null}
              {o.stale ? <span className="text-warning">older version</span> : null}
            </label>
          </li>
        ))}
        {matches.length === 0 ? <li className="px-2 py-1">No strategy matches.</li> : null}
        {matches.length > shown.length ? (
          <li className="px-2 py-1 text-faint">
            {matches.length - shown.length} more: type to narrow the list.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
