/**
 * Commodity Lab › Sweep verdict (BL-218): what the two-year sweep of Dir, Widesl and Buy on the
 * four MCX minis concluded. A record of the backlog item's Log (2026-11-11), not a live
 * computation: the sweep's result files are not served. One setting passed; the page says so
 * with its caveats, and that it is a lead for the forward test, not a strategy.
 */

import { useAppRoute } from '../../hooks/useAppRoute';
import {
  SWEEP_CAVEATS,
  SWEEP_FINALISTS,
  SWEEP_FIT_ROOTS,
  SWEEP_RULES,
} from '../../lib/commodityView';
import { formatInr, formatNumber } from '../../lib/format';
import { pnlClass } from '../optionslab/shared';
import { Badge } from '../ui/Badge';
import { Card, CardHeader } from '../ui/Card';
import { THead, TRow, Table, Td, Th } from '../ui/Table';

export function CommoditySweep() {
  const { navigate } = useAppRoute();
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="The verdict"
          description="Fit year Nov 2024 – Oct 2025, test year Nov 2025 – Oct 2026. One lot, after MCX charges and 1% slippage on every fill."
        />
        <div className="space-y-2 text-sm text-muted">
          <p>
            <span className="font-medium text-foreground">One setting works on this evidence:</span>{' '}
            gold Dir in the expiry week. Crude (killed on the fit year), natural gas, silver, Widesl
            and both Buy families did not pass.
          </p>
          <p>
            It is a lead for a forward paper test, not for live money.{' '}
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => navigate('commoditylab', 'forward')}
            >
              See the forward test
            </button>
            .
          </p>
        </div>
      </Card>

      <Card flush>
        <div className="p-5 pb-0">
          <CardHeader
            title="The eight finalists on the test year"
            description="The best surviving setting of each fit-year cohort, confirmed before the test year was read."
          />
        </div>
        <div className="px-5 pb-5">
          <Table>
            <THead>
              <Th dense>Setting</Th>
              <Th dense align="right">
                Test net
              </Th>
              <Th dense align="right">
                A session
              </Th>
              <Th dense align="right">
                Profit factor
              </Th>
              <Th dense align="right">
                Lower bound
              </Th>
              <Th dense align="right">
                At 0.5%
              </Th>
              <Th dense align="right">
                At 0%
              </Th>
              <Th dense>Verdict</Th>
            </THead>
            <tbody>
              {SWEEP_FINALISTS.map((f) => (
                <TRow key={f.name}>
                  <Td dense className="min-w-[14rem]">
                    <div className="font-medium text-foreground">{f.name}</div>
                    <div className="text-[11px] text-faint">{f.setting}</div>
                  </Td>
                  <Td dense align="right" numeric className={pnlClass(f.testNet)}>
                    {formatInr(f.testNet, { sign: true })}
                  </Td>
                  <Td dense align="right" numeric className={pnlClass(f.perSession)}>
                    {formatInr(f.perSession, { sign: true })}
                  </Td>
                  <Td dense align="right" numeric>
                    {formatNumber(f.profitFactor, 2)}
                  </Td>
                  <Td dense align="right" numeric className={pnlClass(f.lowerBound)}>
                    {formatInr(f.lowerBound, { sign: true })}
                  </Td>
                  <Td dense align="right" numeric className={pnlClass(f.net05)}>
                    {formatInr(f.net05, { sign: true })}
                  </Td>
                  <Td dense align="right" numeric className={pnlClass(f.net0)}>
                    {formatInr(f.net0, { sign: true })}
                  </Td>
                  <Td dense className="whitespace-nowrap">
                    {f.failed.length === 0 ? (
                      <Badge tone="positive">Passed</Badge>
                    ) : (
                      <Badge tone="negative">Failed rule {f.failed.join(', ')}</Badge>
                    )}
                  </Td>
                </TRow>
              ))}
            </tbody>
          </Table>
          <ol className="mt-3 list-decimal space-y-0.5 pl-5 text-xs text-muted">
            {SWEEP_RULES.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ol>
        </div>
      </Card>

      <Card flush>
        <div className="p-5 pb-0">
          <CardHeader
            title="Why the sellers mostly lose: charges"
            description="Fit-year averages a session on one lot. Dir and Widesl sell options and made money before charges on every root; a ₹10-a-point lot cannot carry four ₹20 orders and GST on crude or gas."
          />
        </div>
        <div className="px-5 pb-5">
          <Table>
            <THead>
              <Th dense>Root</Th>
              <Th dense align="right">
                Dir gross
              </Th>
              <Th dense align="right">
                Dir charges
              </Th>
              <Th dense align="right">
                Widesl gross
              </Th>
              <Th dense align="right">
                Widesl charges
              </Th>
              <Th dense>Buys</Th>
              <Th dense>Cohorts that survived the fit year</Th>
            </THead>
            <tbody>
              {SWEEP_FIT_ROOTS.map((r) => (
                <TRow key={r.root}>
                  <Td dense className="font-medium">
                    {r.root}
                  </Td>
                  <Td dense align="right" numeric className={pnlClass(r.dirGross)}>
                    {formatInr(r.dirGross, { sign: true })}
                  </Td>
                  <Td dense align="right" numeric className="text-muted">
                    {formatInr(r.dirCharges)}
                  </Td>
                  <Td dense align="right" numeric className={pnlClass(r.widGross)}>
                    {formatInr(r.widGross, { sign: true })}
                  </Td>
                  <Td dense align="right" numeric className="text-muted">
                    {formatInr(r.widCharges)}
                  </Td>
                  <Td dense className="text-xs text-muted">
                    {r.buys}
                  </Td>
                  <Td dense className="text-xs text-muted">
                    {r.survivors}
                  </Td>
                </TRow>
              ))}
            </tbody>
          </Table>
        </div>
      </Card>

      <Card>
        <CardHeader title="Read with care" />
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          {SWEEP_CAVEATS.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] text-faint">
          Figures copied from BL-218’s Log (11 Nov 2026); the sweep’s result files are not served by
          the API, so nothing here is recomputed.
        </p>
      </Card>
    </div>
  );
}
