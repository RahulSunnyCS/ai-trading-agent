/**
 * RegimeView — daily regime tag history from GET /api/regime-tags.
 *
 * Regime → tone: RANGING → info · TRENDING_STRONG → positive ·
 * VOLATILE_REVERTING → warning · EVENT_DAY → accent · else neutral.
 */

import { useRegimeTags } from '../hooks/useRegimeTags';
import {
  EMPTY,
  formatIstDate,
  formatIstDateTimeShort,
  formatPct,
  toNumberOrNull,
} from '../lib/format';
import type { RegimeTag } from '../types/trading';
import { Badge, type Tone } from './ui/Badge';
import { Card } from './ui/Card';
import { RefreshButton } from './ui/RefreshButton';
import { SkeletonRows } from './ui/Skeleton';
import { StateMessage } from './ui/StateMessage';
import { THead, TRow, Table, Td, Th } from './ui/Table';

function regimeTone(regime: string): Tone {
  switch (regime) {
    case 'RANGING':
      return 'info';
    case 'TRENDING_STRONG':
      return 'positive';
    case 'VOLATILE_REVERTING':
      return 'warning';
    case 'EVENT_DAY':
      return 'accent';
    default:
      return 'neutral';
  }
}

function ConfidenceCell({ raw }: { raw: string | null }) {
  const n = toNumberOrNull(raw);
  if (n === null) return <span className="text-faint">{EMPTY}</span>;
  return <span className="tabular-nums text-foreground">{formatPct(n, 1)}</span>;
}

function RegimeTable({ tags }: { tags: RegimeTag[] }) {
  return (
    <Table>
      <THead>
        <Th>Date (IST)</Th>
        <Th>Symbol</Th>
        <Th>Regime</Th>
        <Th align="right">Confidence</Th>
        <Th>Classified At (IST)</Th>
      </THead>
      <tbody>
        {tags.map((tag) => (
          <TRow key={`${tag.trade_date}-${tag.symbol}`}>
            <Td numeric className="text-foreground">
              {formatIstDate(tag.trade_date)}
            </Td>
            <Td className="text-muted">{tag.symbol}</Td>
            <Td>
              <Badge tone={regimeTone(tag.regime)}>{tag.regime}</Badge>
            </Td>
            <Td numeric align="right">
              <ConfidenceCell raw={tag.regime_confidence} />
            </Td>
            <Td numeric className="text-muted">
              {formatIstDateTimeShort(tag.classified_at)}
            </Td>
          </TRow>
        ))}
      </tbody>
    </Table>
  );
}

export function RegimeView() {
  const { tags, loading, error, refresh } = useRegimeTags();
  const hasData = tags.length > 0;

  return (
    <Card flush>
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            Daily Regime Tags
          </h2>
          <p className="mt-0.5 text-sm text-muted">
            Market-regime classification, most recent first
          </p>
        </div>
        <RefreshButton onClick={refresh} loading={loading} />
      </div>

      <div className="px-2 py-1">
        {loading && !hasData && <SkeletonRows rows={5} className="px-1 pt-2" />}
        {error !== null && (
          <StateMessage
            variant="error"
            title="Couldn't load regime tags — retrying…"
            description={error}
            className="m-3"
          />
        )}
        {!loading && error === null && !hasData && (
          <StateMessage
            variant="empty"
            title="No regime tags yet"
            description="Tags appear after the EOD retrospection engine classifies at least one trading day."
          />
        )}
        {hasData && <RegimeTable tags={tags} />}
      </div>
    </Card>
  );
}
