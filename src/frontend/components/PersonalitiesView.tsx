/**
 * PersonalitiesView — the personality engine config table from GET /api/personalities.
 *
 * Management style → tone:  hold → info · roll → warning · cut_reenter → accent.
 */

import { RefreshCw } from 'lucide-react';

import { usePersonalities } from '../hooks/usePersonalities.js';
import type { Personality } from '../types/trading.js';
import { Badge, type Tone } from './ui/Badge';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { SkeletonRows } from './ui/Skeleton';
import { StateMessage } from './ui/StateMessage';
import { StatusDot } from './ui/StatusDot';
import { THead, TRow, Table, Td, Th } from './ui/Table';

function managementTone(style: string): Tone {
  switch (style) {
    case 'hold':
      return 'info';
    case 'roll':
      return 'warning';
    case 'cut_reenter':
      return 'accent';
    default:
      return 'neutral';
  }
}

function managementLabel(style: string): string {
  return style === 'cut_reenter' ? 'Cut+Re-enter' : style.charAt(0).toUpperCase() + style.slice(1);
}

function ParamsSummary({ params }: { params: Record<string, unknown> }) {
  const parts: string[] = [];
  if (typeof params.min_probability === 'number') {
    parts.push(`min_prob: ${(params.min_probability * 100).toFixed(0)}%`);
  }
  if (typeof params.sl_pct === 'number') {
    parts.push(`sl: ${params.sl_pct}%`);
  }
  if (parts.length === 0) return <span className="text-xs text-faint">—</span>;
  return <span className="text-xs tabular-nums text-muted">{parts.join(' · ')}</span>;
}

function PersonalitiesTable({ personalities }: { personalities: Personality[] }) {
  return (
    <Table>
      <THead>
        <Th>Status</Th>
        <Th>Name</Th>
        <Th>Group</Th>
        <Th>Entry Type</Th>
        <Th>Management</Th>
        <Th align="right">Phase</Th>
        <Th>Key Params</Th>
      </THead>
      <tbody>
        {personalities.map((p) => (
          <TRow key={p.id}>
            <Td>
              <div className="flex items-center gap-2">
                <StatusDot tone={p.is_active ? 'positive' : 'neutral'} pulse={p.is_active} />
                {p.is_frozen && <Badge tone="neutral">Frozen</Badge>}
              </div>
            </Td>
            <Td>
              <span className="font-medium text-foreground">{p.display_name}</span>
              <span className="ml-1.5 text-xs text-faint">{p.name}</span>
            </Td>
            <Td className="capitalize text-muted">{p.group_type}</Td>
            <Td className="text-muted">{p.entry_type.replace(/_/g, ' ')}</Td>
            <Td>
              <Badge tone={managementTone(p.management_style)}>
                {managementLabel(p.management_style)}
              </Badge>
            </Td>
            <Td numeric align="right" className="text-muted">
              {p.phase}
            </Td>
            <Td>
              <ParamsSummary params={p.params} />
            </Td>
          </TRow>
        ))}
      </tbody>
    </Table>
  );
}

export function PersonalitiesView() {
  const { personalities, loading, error, refresh } = usePersonalities();
  const hasData = personalities.length > 0;

  return (
    <Card flush>
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            Trading Personalities
          </h2>
          <p className="mt-0.5 text-sm text-muted">
            Decision-engine configurations for the M2 engine
          </p>
        </div>
        <Button size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <div className="px-2 py-1">
        {loading && !hasData && <SkeletonRows rows={5} className="px-1 pt-2" />}
        {error !== null && (
          <StateMessage
            variant="error"
            title="Couldn't load personalities — retrying…"
            description={error}
            className="m-3"
          />
        )}
        {!loading && error === null && !hasData && (
          <StateMessage
            variant="empty"
            title="No personalities found"
            description="Personality configs appear once the M2 seed migration has run."
          />
        )}
        {hasData && <PersonalitiesTable personalities={personalities} />}
      </div>
    </Card>
  );
}
