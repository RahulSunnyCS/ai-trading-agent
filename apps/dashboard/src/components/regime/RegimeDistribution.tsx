/** Share of the window's tagged days per regime, one tile each, defined behind the (i). */

import { formatInt, formatPct } from '../../lib/format';
import { regimeMeta } from '../../lib/regimeMeta';
import type { RegimeShare } from '../../lib/regimeTags';
import { StatCard } from '../ui/StatCard';

export function RegimeDistribution({
  rows,
  total,
}: {
  rows: readonly RegimeShare[];
  total: number;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {rows.map((row) => {
        const meta = regimeMeta(row.regime);
        return (
          <StatCard
            key={row.regime}
            label={meta.label}
            icon={<span aria-hidden="true">{meta.glyph}</span>}
            hint={meta.definition}
            value={formatPct(row.share, 1)}
            tone={row.days === 0 ? 'muted' : 'default'}
            note={`${formatInt(row.days)} of ${formatInt(total)} tagged days`}
          />
        );
      })}
    </div>
  );
}
