/**
 * The rotation screens' list picker: a segmented control over the lists the dashboard shows
 * (`VISIBLE_LIST_KEYS`). A one-option choice is not a choice, so with a single list it renders no
 * control: the list's name as plain text (`single="text"`), or nothing at all (`single="none"`,
 * for a widget whose page already names the list).
 */

import { type ListKey, VISIBLE_LIST_KEYS, listName } from '../../../lib/rotationListNames';
import { SegmentedControl, type SegmentedOption } from '../../ui/SegmentedControl';

export function ListPicker({
  value,
  onChange,
  ariaLabel,
  label,
  keys = VISIBLE_LIST_KEYS,
  format = listName,
  single = 'none',
}: {
  value: ListKey;
  onChange: (key: ListKey) => void;
  /** Names the control for assistive tech ("Focus list"). */
  ariaLabel: string;
  /** A short caption before the control ("Focus"); not shown for a single list. */
  label?: string;
  /** The keys offered; the shown lists by default. */
  keys?: readonly ListKey[];
  format?: (key: ListKey) => string;
  single?: 'text' | 'none';
}) {
  if (keys.length === 0) return null;
  if (keys.length === 1) {
    const only = keys[0] as ListKey;
    return single === 'text' ? (
      <span className="text-xs font-medium text-foreground" data-testid="list-picker-single">
        {format(only)}
      </span>
    ) : null;
  }
  const options: SegmentedOption<ListKey>[] = keys.map((k) => ({ value: k, label: format(k) }));
  const control = (
    <SegmentedControl
      value={value}
      options={options}
      onChange={onChange}
      ariaLabel={ariaLabel}
      size="sm"
    />
  );
  return label ? (
    <div className="flex items-center gap-2 text-xs text-muted">
      {label}
      {control}
    </div>
  ) : (
    control
  );
}
