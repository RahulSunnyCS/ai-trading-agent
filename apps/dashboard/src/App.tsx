import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';

import { BackfillView } from './components/BackfillView';
import { BacktestView } from './components/BacktestView';
import { LiveView } from './components/LiveView';
import { MomentumBacktestingView } from './components/MomentumBacktestingView';
import { OptionsLabView } from './components/OptionsLabView';
import { PaymentTestModeBanner } from './components/PaymentTestModeBanner';
import { PersonalitiesView } from './components/PersonalitiesView';
import { PnlView } from './components/PnlView';
import { PricingPage } from './components/PricingPage';
import { RegimeView } from './components/RegimeView';
import { ReplayView } from './components/ReplayView';
import { SettingsView } from './components/SettingsView';
import { TradesView } from './components/TradesView';
import { Sidebar } from './components/shell/Sidebar';
import { Topbar } from './components/shell/Topbar';
import { type Tab, tabLabel } from './components/shell/nav';
import { PENDING_BY_TAB } from './components/shell/pending';
import { hydrateThemeFromStorage } from './store/theme';
import {
  DEFAULT_NAVIGATION_PREFERENCES,
  firstVisibleTab,
  loadNavigationPreferences,
  normalizeNavigationPreferences,
  saveNavigationPreferences,
  type NavigationPreferences,
} from './store/navigation';

/** One-line subtitle shown under each view's title in the top bar. */
const SUBTITLES: Record<Tab, string> = {
  live: 'Real-time straddle, momentum, and feed status',
  trades: 'Simulated paper-trade log',
  personalities: 'The 10 decision engines and their configs',
  pnl: 'Realized P&L across closed paper trades',
  regime: 'Daily market-regime classification history',
  backfill: 'Historical tick-data ingestion coverage',
  replay: 'Deterministic replay of historical sessions',
  backtest: 'Options strategy backtesting research workbench',
  optionslab: 'Daily 1-minute Fyers data · build, backtest and track leg-wise option strategies',
  momentum: 'Weekly rotation research across ETFs, stocks and categories',
  pricing: 'Subscription access and feature credits',
  settings: 'Choose which tabs appear and arrange their navigation priority',
};

function renderView(
  tab: Tab,
  preferences: NavigationPreferences,
  onPreferencesChange: (preferences: NavigationPreferences) => void,
) {
  switch (tab) {
    case 'live':
      return <LiveView />;
    case 'trades':
      return <TradesView />;
    case 'personalities':
      return <PersonalitiesView />;
    case 'pnl':
      return <PnlView />;
    case 'regime':
      return <RegimeView />;
    case 'backfill':
      return <BackfillView />;
    case 'replay':
      return <ReplayView />;
    case 'backtest':
      return <BacktestView />;
    case 'optionslab':
      return <OptionsLabView />;
    case 'momentum':
      return <MomentumBacktestingView />;
    case 'pricing':
      return <PricingPage />;
    case 'settings':
      return <SettingsView preferences={preferences} onChange={onPreferencesChange} />;
  }
}

/**
 * Application shell: a fixed grouped sidebar (desktop) / slide-over drawer
 * (mobile), a sticky top bar with live status + theme toggle, and the active
 * view rendered in a centered content column.
 */
export function App() {
  const [activeTab, setActiveTab] = useState<Tab>('live');
  const [menuOpen, setMenuOpen] = useState(false);
  const [navigationPreferences, setNavigationPreferences] = useState<NavigationPreferences>(
    DEFAULT_NAVIGATION_PREFERENCES,
  );

  // Client-only, once, after hydration completes: applies the real stored/OS
  // theme preference (see store/theme.ts's module docstring for why this
  // can't happen during render/SSR without crashing hydration).
  useEffect(() => {
    hydrateThemeFromStorage();
    const stored = loadNavigationPreferences();
    setNavigationPreferences(stored);
    if (stored.hidden.includes('live')) setActiveTab(firstVisibleTab(stored));
  }, []);

  function updateNavigationPreferences(nextValue: NavigationPreferences): void {
    const next = normalizeNavigationPreferences(nextValue);
    setNavigationPreferences(next);
    saveNavigationPreferences(next);
    if (next.hidden.includes(activeTab)) setActiveTab(firstVisibleTab(next));
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-border bg-surface/50 lg:block">
        <Sidebar activeTab={activeTab} onSelect={setActiveTab} preferences={navigationPreferences} />
      </aside>

      {/* Mobile nav drawer */}
      <Dialog.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm data-[state=open]:animate-fade-in lg:hidden" />
          <Dialog.Content className="fixed inset-y-0 left-0 z-50 w-64 border-r border-border bg-surface shadow-elevated focus:outline-none data-[state=open]:animate-fade-in lg:hidden">
            <Dialog.Title className="sr-only">Navigation</Dialog.Title>
            <Sidebar
              activeTab={activeTab}
              onSelect={setActiveTab}
              preferences={navigationPreferences}
              onNavigate={() => setMenuOpen(false)}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Main column */}
      <div className="lg:pl-64">
        <Topbar
          title={tabLabel(activeTab)}
          subtitle={SUBTITLES[activeTab]}
          pending={PENDING_BY_TAB[activeTab]}
          onOpenMenu={() => setMenuOpen(true)}
        />
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
          <PaymentTestModeBanner />
          <div key={activeTab} className="animate-fade-in">
            {renderView(activeTab, navigationPreferences, updateNavigationPreferences)}
          </div>
        </main>
      </div>
    </div>
  );
}
