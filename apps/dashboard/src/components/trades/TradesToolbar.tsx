'use client';

import { Download, X } from 'lucide-react';
import { useId } from 'react';

import {
  NO_PERSONALITY,
  type TradeFilters,
  type TradeStatusFilter,
  isRangeInverted,
} from '../../lib/trades';
import { Button } from '../ui/Button';
import { Input, Select } from '../ui/Input';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Toolbar, ToolbarSpacer } from '../ui/Toolbar';

const STATUS_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
] as const;

export interface PersonalityOption {
  value: string;
  label: string;
}

/**
 * Status, personality and IST entry-date filters plus Export CSV. The parent owns the values
 * (they live in the query string); this only renders the controls.
 */
export function TradesToolbar({
  filters,
  personalityOptions,
  onStatus,
  onPersonality,
  onFrom,
  onTo,
  onClear,
  onExport,
  exportCount,
  canClear,
}: {
  filters: TradeFilters;
  personalityOptions: PersonalityOption[];
  onStatus: (status: TradeStatusFilter) => void;
  onPersonality: (id: string | null) => void;
  onFrom: (day: string | null) => void;
  onTo: (day: string | null) => void;
  onClear: () => void;
  onExport: () => void;
  exportCount: number;
  canClear: boolean;
}) {
  const id = useId();
  const inverted = isRangeInverted(filters);
  // A shared link may name a personality this browser's list does not have (yet).
  const knownPersonality =
    filters.personality === null ||
    personalityOptions.some((option) => option.value === filters.personality);

  return (
    <div className="space-y-2">
      <Toolbar ariaLabel="Trade filters">
        <SegmentedControl
          ariaLabel="Trade status"
          size="sm"
          value={filters.status}
          options={STATUS_OPTIONS}
          onChange={onStatus}
        />
        <span className="flex items-center gap-2 text-xs text-muted">
          <label htmlFor={`${id}-personality`}>Personality</label>
          <Select
            id={`${id}-personality`}
            className="w-44"
            value={filters.personality ?? ''}
            onChange={(event) => onPersonality(event.target.value || null)}
          >
            <option value="">All personalities</option>
            {personalityOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            {knownPersonality ? null : (
              <option value={filters.personality ?? ''}>
                {filters.personality === NO_PERSONALITY ? 'Unassigned' : 'Unknown personality'}
              </option>
            )}
          </Select>
        </span>
        <span className="flex items-center gap-2 text-xs text-muted">
          <label htmlFor={`${id}-from`}>From</label>
          <Input
            id={`${id}-from`}
            type="date"
            className="w-36"
            value={filters.from ?? ''}
            max={filters.to ?? undefined}
            aria-invalid={inverted}
            onChange={(event) => onFrom(event.target.value || null)}
          />
        </span>
        <span className="flex items-center gap-2 text-xs text-muted">
          <label htmlFor={`${id}-to`}>To</label>
          <Input
            id={`${id}-to`}
            type="date"
            className="w-36"
            value={filters.to ?? ''}
            min={filters.from ?? undefined}
            aria-invalid={inverted}
            onChange={(event) => onTo(event.target.value || null)}
          />
        </span>
        {canClear ? (
          <Button variant="ghost" size="sm" onClick={onClear}>
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            Clear filters
          </Button>
        ) : null}
        <ToolbarSpacer />
        <Button size="sm" onClick={onExport} disabled={exportCount === 0}>
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          Export CSV
        </Button>
      </Toolbar>
      {inverted ? (
        <output className="block text-xs text-warning">
          From is after To, so no trade matches. Dates are the IST entry day.
        </output>
      ) : null}
    </div>
  );
}
