/**
 * Commodity Lab: the workbench for MCX commodity options (gold, silver, crude oil, natural gas
 * minis). Reached through the Fastify proxy at /api/backtest/legwise/mcx/*. Read-only: nothing here
 * places an order, and the only experiment running is the gold Dir paper test (BL-219).
 *
 *  Today
 *   - Overview: the four minis' expiries and data freshness, and the forward test's headline
 *   - Forward test: the GOLDM Dir expiry-week paper test, scored nightly (BL-219)
 *  Research
 *   - Sweep verdict: what the two-year sweep of Dir, Widesl and Buy concluded (BL-218)
 *  Explore data
 *   - Contracts & data: the collected option bars and the expiry calendar (BL-148)
 *
 * /commoditylab with no section opens Overview.
 */

import { useAppRoute } from '../hooks/useAppRoute';
import {
  COMMODITY_DEFAULT_SECTION,
  COMMODITY_SECTIONS,
  COMMODITY_SECTION_META,
} from '../lib/commodityView';
import { oneOf } from '../lib/routes';
import { CommodityData } from './commodity/CommodityData';
import { CommodityForward } from './commodity/CommodityForward';
import { CommodityOverview } from './commodity/CommodityOverview';
import { CommoditySweep } from './commodity/CommoditySweep';

export function CommodityLabView() {
  const { rest } = useAppRoute();
  const section = oneOf(COMMODITY_SECTIONS, rest[0]) ?? COMMODITY_DEFAULT_SECTION;
  const meta = COMMODITY_SECTION_META[section];
  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <p className="text-xs text-faint">Commodity Lab › {meta.workspace}</p>
        <h2 className="text-lg font-semibold tracking-tight text-foreground">{meta.question}</h2>
        <p className="max-w-3xl text-sm text-muted">{meta.explanation}</p>
      </header>
      {section === 'overview' && <CommodityOverview />}
      {section === 'forward' && <CommodityForward />}
      {section === 'sweep' && <CommoditySweep />}
      {section === 'data' && <CommodityData />}
    </div>
  );
}
