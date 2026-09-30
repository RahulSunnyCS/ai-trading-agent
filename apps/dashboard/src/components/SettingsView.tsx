import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical, RotateCcw } from 'lucide-react';
import { useState, type DragEvent } from 'react';

import type { NavigationPreferences } from '../store/navigation';
import { DEFAULT_NAVIGATION_PREFERENCES, moveTabBefore } from '../store/navigation';
import { Button } from './ui/Button';
import { Card, CardHeader } from './ui/Card';
import { NAV_GROUPS, type Tab } from './shell/nav';
import { PENDING_BY_TAB } from './shell/pending';
import { cn } from '../lib/cn';

interface SettingsViewProps {
  preferences: NavigationPreferences;
  onChange: (preferences: NavigationPreferences) => void;
}

export function SettingsView({ preferences, onChange }: SettingsViewProps) {
  const [dragging, setDragging] = useState<Tab | null>(null);
  const hidden = new Set(preferences.hidden);
  const rank = new Map(preferences.order.map((id, index) => [id, index]));

  function toggleVisibility(tab: Tab): void {
    const nextHidden = hidden.has(tab)
      ? preferences.hidden.filter((id) => id !== tab)
      : [...preferences.hidden, tab];
    onChange({ ...preferences, hidden: nextHidden });
  }

  function reorder(groupTabs: Tab[], tab: Tab, direction: -1 | 1): void {
    const index = groupTabs.indexOf(tab);
    const swapWith = groupTabs[index + direction];
    if (!swapWith) return;
    const next = [...preferences.order];
    const from = next.indexOf(tab);
    const to = next.indexOf(swapWith);
    const moved = next[from];
    const displaced = next[to];
    if (!moved || !displaced) return;
    next[from] = displaced;
    next[to] = moved;
    onChange({ ...preferences, order: next });
  }

  function dropBefore(event: DragEvent, target: Tab, groupTabs: Tab[]): void {
    event.preventDefault();
    if (!dragging || !groupTabs.includes(dragging)) return;
    onChange({ ...preferences, order: moveTabBefore(preferences.order, dragging, target) });
    setDragging(null);
  }

  const visibleCount = preferences.order.length - preferences.hidden.length;

  return (
    <div className="space-y-5">
      <CardHeader
        title="Navigation settings"
        description={`${visibleCount} of ${preferences.order.length} optional tabs shown. Settings stays pinned so you can always restore hidden tabs.`}
        actions={
          <Button variant="secondary" size="sm" onClick={() => onChange(DEFAULT_NAVIGATION_PREFERENCES)}>
            <RotateCcw className="h-3.5 w-3.5" /> Reset
          </Button>
        }
      />

      {NAV_GROUPS.map((group) => {
        const items = group.items
          .filter((item) => item.id !== 'settings')
          .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
        if (items.length === 0) return null;
        const groupTabs = items.map((item) => item.id);
        return (
          <Card key={group.heading} flush>
            <div className="border-b border-border px-5 py-4">
              <h2 className="text-sm font-semibold text-foreground">{group.heading}</h2>
              <p className="mt-0.5 text-xs text-muted">Drag tabs to set their priority within this section.</p>
            </div>
            <div className="divide-y divide-border">
              {items.map((item, index) => {
                const Icon = item.icon;
                const isHidden = hidden.has(item.id);
                const pending = PENDING_BY_TAB[item.id].length;
                return (
                  <div
                    key={item.id}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => dropBefore(event, item.id, groupTabs)}
                    className={cn(
                      'flex items-center gap-3 px-4 py-3 transition-colors',
                      dragging === item.id ? 'bg-primary/8' : 'hover:bg-surface-2/60',
                    )}
                  >
                    <button
                      type="button"
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = 'move';
                        setDragging(item.id);
                      }}
                      onDragEnd={() => setDragging(null)}
                      aria-label={`Drag ${item.label}`}
                      className="cursor-grab rounded p-1 text-faint hover:bg-surface-2 hover:text-muted active:cursor-grabbing"
                    >
                      <GripVertical className="h-4 w-4" />
                    </button>
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className={cn('text-sm font-medium', isHidden ? 'text-faint' : 'text-foreground')}>
                        {item.label}
                      </div>
                      <div className="text-xs text-faint">
                        {pending > 0 ? `${pending} pending ${pending === 1 ? 'item' : 'items'}` : 'Ready'}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => reorder(groupTabs, item.id, -1)}
                        disabled={index === 0}
                        aria-label={`Move ${item.label} up`}
                        className="rounded-md p-2 text-faint hover:bg-surface-2 hover:text-foreground disabled:opacity-30"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => reorder(groupTabs, item.id, 1)}
                        disabled={index === items.length - 1}
                        aria-label={`Move ${item.label} down`}
                        className="rounded-md p-2 text-faint hover:bg-surface-2 hover:text-foreground disabled:opacity-30"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleVisibility(item.id)}
                        aria-pressed={!isHidden}
                        aria-label={`${isHidden ? 'Show' : 'Hide'} ${item.label}`}
                        className={cn(
                          'ml-1 inline-flex min-w-24 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors',
                          isHidden
                            ? 'border-border bg-surface text-muted hover:bg-surface-2'
                            : 'border-primary/25 bg-primary/10 text-primary hover:bg-primary/15',
                        )}
                      >
                        {isHidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        {isHidden ? 'Hidden' : 'Shown'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        );
      })}

      <Card className="border-dashed">
        <p className="text-sm text-muted">
          Settings is always visible and pinned last under Account. Visibility and order are saved only in this browser.
        </p>
      </Card>
    </div>
  );
}
