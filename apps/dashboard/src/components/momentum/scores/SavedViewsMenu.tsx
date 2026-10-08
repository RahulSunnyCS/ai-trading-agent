'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Bookmark, Check, ChevronRight } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';

import {
  DEFAULT_STOCKS_SETTINGS,
  type StocksViewSettings,
  describeSettings,
  sameSettings,
} from '../../../lib/momentumScores';
import {
  MAX_SAVED_VIEWS,
  MAX_VIEW_NAME,
  type SaveResult,
  type SavedView,
} from '../../../store/momentumScoresViews';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { toast } from '../../ui/Toast';

const DEFAULT_ID = '__default__';

const ITEM =
  'flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-surface-2';

const REFUSAL: Record<Exclude<SaveResult, 'saved' | 'replaced'>, string> = {
  empty: 'Give the view a name.',
  full: `${MAX_SAVED_VIEWS} views is the most. Delete one, or reuse a name to replace it.`,
};

/**
 * Saved views of the Stocks list, kept in this browser: a button that opens the list (pick one to
 * apply it, "All stocks" to go back to the default) and, from "Save current view…", a name field
 * beside it. The list itself always opens on All; nothing here applies by itself.
 */
export function SavedViewsMenu({
  views,
  current,
  onApply,
  onSave,
  onDelete,
}: {
  views: readonly SavedView[];
  /** What the list is showing now, to tick the view it matches and to save. */
  current: StocksViewSettings;
  onApply: (settings: StocksViewSettings) => void;
  onSave: (name: string) => SaveResult;
  onDelete: (name: string) => void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const wantsName = useRef(false);

  const matching = views.find((view) => sameSettings(view.settings, current));
  const checked = matching
    ? matching.name
    : sameSettings(DEFAULT_STOCKS_SETTINGS, current)
      ? DEFAULT_ID
      : '';

  const pick = (value: string): void => {
    if (value === DEFAULT_ID) onApply(DEFAULT_STOCKS_SETTINGS);
    else {
      const view = views.find((option) => option.name === value);
      if (view) onApply(view.settings);
    }
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const result = onSave(name);
    if (result === 'saved' || result === 'replaced') {
      toast(result === 'saved' ? `Saved the view “${name.trim()}”` : `Updated “${name.trim()}”`);
      setNaming(false);
      setName('');
      setRefusal(null);
    } else setRefusal(REFUSAL[result]);
  };

  return (
    <div className="flex items-center gap-2">
      {naming ? (
        <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
          <Input
            ref={nameRef}
            aria-label="Name for this view"
            aria-invalid={refusal ? true : undefined}
            placeholder="Name this view"
            maxLength={MAX_VIEW_NAME}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setRefusal(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setNaming(false);
                setRefusal(null);
              }
            }}
            className="w-44"
          />
          <Button size="sm" variant="primary" type="submit">
            Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setNaming(false);
              setRefusal(null);
            }}
          >
            Cancel
          </Button>
          {refusal ? (
            <span role="alert" className="text-xs text-negative">
              {refusal}
            </span>
          ) : null}
        </form>
      ) : null}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label="Saved views"
            className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border-strong bg-surface-2 px-3 text-xs text-foreground transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Bookmark className="h-3.5 w-3.5" aria-hidden="true" />
            Views
            {views.length ? <span className="metric text-faint">{views.length}</span> : null}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            onCloseAutoFocus={(event) => {
              if (!wantsName.current) return;
              wantsName.current = false;
              event.preventDefault();
              nameRef.current?.focus();
            }}
            className="z-50 w-72 rounded-lg border border-border-strong bg-surface p-1 shadow-elevated"
          >
            <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-faint">
              Saved views
            </DropdownMenu.Label>
            <DropdownMenu.RadioGroup value={checked} onValueChange={pick}>
              <DropdownMenu.RadioItem value={DEFAULT_ID} className={ITEM}>
                <span className="w-3.5 text-primary">
                  <DropdownMenu.ItemIndicator>
                    <Check className="h-3.5 w-3.5" />
                  </DropdownMenu.ItemIndicator>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-foreground">All stocks</span>
                  <span className="block truncate text-xs text-faint">The default</span>
                </span>
              </DropdownMenu.RadioItem>
              {views.map((view) => (
                <DropdownMenu.RadioItem key={view.name} value={view.name} className={ITEM}>
                  <span className="w-3.5 text-primary">
                    <DropdownMenu.ItemIndicator>
                      <Check className="h-3.5 w-3.5" />
                    </DropdownMenu.ItemIndicator>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-foreground">{view.name}</span>
                    <span className="block truncate text-xs text-faint">
                      {describeSettings(view.settings)}
                    </span>
                  </span>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <DropdownMenu.Item
              className={ITEM}
              onSelect={() => {
                wantsName.current = true;
                setNaming(true);
              }}
            >
              <span className="w-3.5" />
              <span className="flex-1 text-foreground">Save current view…</span>
            </DropdownMenu.Item>
            {views.length ? (
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger className={ITEM}>
                  <span className="w-3.5" />
                  <span className="flex-1 text-foreground">Delete a view</span>
                  <ChevronRight className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                </DropdownMenu.SubTrigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.SubContent
                    sideOffset={4}
                    className="z-50 w-60 rounded-lg border border-border-strong bg-surface p-1 shadow-elevated"
                  >
                    {views.map((view) => (
                      <DropdownMenu.Item
                        key={view.name}
                        className={ITEM}
                        onSelect={() => onDelete(view.name)}
                      >
                        <span className="truncate text-negative">Delete {view.name}</span>
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
