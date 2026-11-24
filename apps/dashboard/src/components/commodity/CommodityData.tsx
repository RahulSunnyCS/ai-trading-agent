/**
 * Commodity Lab › Contracts & data: what the nightly MCX collection (BL-148) has put in the lake
 * per root, and the upcoming expiries each root's calendar knows. Read-only.
 */

import { useCommodityOverview } from '../../hooks/useCommodity';
import { ROOT_UNIT, expiryText, staleWeekdays } from '../../lib/commodityView';
import { EMPTY, formatDay, formatDayShort } from '../../lib/format';
import { Badge } from '../ui/Badge';
import { Card, CardHeader } from '../ui/Card';
import { RefreshButton } from '../ui/RefreshButton';
import { SkeletonRows } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../ui/Table';

export function CommodityData() {
  const res = useCommodityOverview();
  const d = res.data;
  return (
    <div className="space-y-5">
      <Card flush>
        <div className="p-5 pb-0">
          <CardHeader
            title="Collected option bars"
            description="1-minute option bars with open interest, one file a trading day, from Fyers (Angel One as a fallback). Expired contracts cannot be fetched later, so a missed night is a hole."
            actions={<RefreshButton onClick={res.refetch} loading={res.loading} />}
          />
        </div>
        <div className="px-5 pb-5">
          {res.error ? (
            <StateMessage
              variant="error"
              title="Could not read the commodity data"
              description={res.error}
            />
          ) : d === null ? (
            <SkeletonRows rows={4} />
          ) : (
            <Table>
              <THead>
                <Th dense>Root</Th>
                <Th dense>Contract</Th>
                <Th dense>From</Th>
                <Th dense>To</Th>
                <Th dense align="right">
                  Days
                </Th>
                <Th dense align="right">
                  Last 30 days
                </Th>
                <Th dense>Status</Th>
              </THead>
              <tbody>
                {d.roots.map((r) => {
                  const stale = staleWeekdays(r, d.as_of);
                  return (
                    <TRow key={r.root}>
                      <Td dense className="font-medium">
                        {r.root}
                      </Td>
                      <Td dense className="text-xs text-muted">
                        {ROOT_UNIT[r.root] ?? EMPTY}
                      </Td>
                      <Td dense>{formatDay(r.first_day)}</Td>
                      <Td dense>{formatDay(r.last_day)}</Td>
                      <Td dense align="right" numeric>
                        {r.days_collected}
                      </Td>
                      <Td dense align="right" numeric>
                        {r.days_last_30}
                      </Td>
                      <Td dense>
                        <Badge
                          tone={stale === null ? 'neutral' : stale <= 1 ? 'positive' : 'warning'}
                        >
                          {stale === null
                            ? 'No data'
                            : stale <= 1
                              ? 'Up to date'
                              : `${stale} weekdays behind`}
                        </Badge>
                      </Td>
                    </TRow>
                  );
                })}
              </tbody>
            </Table>
          )}
        </div>
      </Card>

      <Card flush>
        <div className="p-5 pb-0">
          <CardHeader
            title="Expiry calendar"
            description="Each option expiry and the future it settles on (the future is the spot the engine uses). Only gold’s and silver’s calendars run past October 2026; the forward tests keep them current."
          />
        </div>
        <div className="px-5 pb-5">
          {d === null ? (
            <SkeletonRows rows={3} />
          ) : (
            <Table>
              <THead>
                <Th dense>Root</Th>
                <Th dense>Next expiry</Th>
                <Th dense>Settles on</Th>
                <Th dense>Then</Th>
                <Th dense>Calendar ends</Th>
              </THead>
              <tbody>
                {d.roots.map((r) => (
                  <TRow key={r.root}>
                    <Td dense className="font-medium">
                      {r.root}
                    </Td>
                    <Td dense className="whitespace-nowrap">
                      {expiryText(r)}
                    </Td>
                    <Td dense className="text-xs text-muted">
                      {r.future?.replace('MCX:', '') ?? EMPTY}
                    </Td>
                    <Td dense className="text-xs text-muted">
                      {r.upcoming
                        .slice(1)
                        .map((e) => formatDayShort(e))
                        .join(' · ') || EMPTY}
                    </Td>
                    <Td dense>{formatDay(r.calendar_ends)}</Td>
                  </TRow>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </Card>
    </div>
  );
}
