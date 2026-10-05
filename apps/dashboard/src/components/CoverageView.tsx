/**
 * CoverageView — Data › Coverage: historical data backfill and the replays it makes possible,
 * as two sections of one tab (`/coverage/backfill`, `/coverage/replay`). They were separate
 * Backfill and Replay tabs; their old paths redirect here (see PATH_ALIASES in lib/routes.ts).
 */

import { useAppRoute } from '../hooks/useAppRoute';
import {
  COVERAGE_DEFAULT_SECTION,
  COVERAGE_SECTIONS,
  type CoverageSection,
  oneOf,
} from '../lib/routes';
import { BackfillView } from './BackfillView';
import { ReplayView } from './ReplayView';
import { type TabItem, Tabs } from './ui/Tabs';

const SECTION_LABEL: Record<CoverageSection, string> = {
  backfill: 'Backfill',
  replay: 'Replay',
};

const SECTIONS: TabItem<CoverageSection>[] = COVERAGE_SECTIONS.map((value) => ({
  value,
  label: SECTION_LABEL[value],
}));

export function CoverageView() {
  const { rest, navigate } = useAppRoute();
  const section = oneOf(COVERAGE_SECTIONS, rest[0]) ?? COVERAGE_DEFAULT_SECTION;
  return (
    <div className="space-y-5">
      <Tabs
        value={section}
        items={SECTIONS}
        onChange={(next) => navigate('coverage', next)}
        ariaLabel="Coverage sections"
        variant="pill"
        className="w-fit"
      />
      {section === 'backfill' && <BackfillView />}
      {section === 'replay' && <ReplayView />}
    </div>
  );
}
