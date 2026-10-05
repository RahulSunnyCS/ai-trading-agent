import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';

import { useAppRoute } from './hooks/useAppRoute';
import { DEFAULT_TAB, aliasTarget, documentTitle } from './lib/routes';

import { BrokerLoginsView } from './components/BrokerLoginsView';
import { CoverageView } from './components/CoverageView';
import { LiveView } from './components/LiveView';
import { MomentumBacktestingView } from './components/MomentumBacktestingView';
import { OptionsLabView } from './components/OptionsLabView';
import { OverviewView } from './components/OverviewView';
import { PersonalitiesView } from './components/PersonalitiesView';
import { PnlView } from './components/PnlView';
import { PricingPage } from './components/PricingPage';
import { RegimeView } from './components/RegimeView';
import { SettingsView } from './components/SettingsView';
import { TradesView } from './components/TradesView';
import { BottomBar } from './components/shell/BottomBar';
import { Sidebar } from './components/shell/Sidebar';
import { TokenBanner } from './components/shell/TokenBanner';
import { Topbar } from './components/shell/Topbar';
import { type Tab, tabLabel } from './components/shell/nav';
import { PENDING_BY_TAB } from './components/shell/pending';
import { Toaster } from './components/ui/Toast';
import {
  DEFAULT_NAVIGATION_PREFERENCES,
  type NavigationPreferences,
  firstVisibleTab,
  loadNavigationPreferences,
  normalizeNavigationPreferences,
  saveNavigationPreferences,
} from './store/navigation';
import { hydrateRegimeCutsFromStorage } from './store/regimeCuts';
import { getLandingTab, hydrateSettingsFromStorage } from './store/settings';
import { hydrateThemeFromStorage } from './store/theme';

/** One-line subtitle shown under each view's title in the top bar. */
const SUBTITLES: Record<Tab, string> = {
  overview: 'Today at a glance: market, feed, token, positions and scheduled jobs',
  live: 'Real-time straddle, momentum, and feed status',
  trades: 'Simulated paper-trade log',
  personalities: 'The 10 decision engines and their configs',
  pnl: 'Realized P&L across closed paper trades',
  regime: 'Daily market-regime classification history',
  coverage: 'Historical candle backfill, and the ranges it makes replayable',
  optionslab:
    'Build, backtest and track option strategies: leg-wise on 1-minute Fyers data, or the YAML engine',
  momentum: 'Weekly rotation research across ETFs, stocks and categories',
  brokerLogins: 'Connect and manage the market-data brokers used across the dashboard',
  pricing: 'Your credits, payment mode and plans',
  settings: 'Choose which tabs appear and arrange their navigation priority',
};

function renderView(
  tab: Tab,
  preferences: NavigationPreferences,
  onPreferencesChange: (preferences: NavigationPreferences) => void,
) {
  switch (tab) {
    case 'overview':
      return <OverviewView />;
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
    case 'coverage':
      return <CoverageView />;
    case 'optionslab':
      return <OptionsLabView />;
    case 'momentum':
      return <MomentumBacktestingView />;
    case 'brokerLogins':
      return <BrokerLoginsView />;
    case 'pricing':
      return <PricingPage />;
    case 'settings':
      return <SettingsView preferences={preferences} onChange={onPreferencesChange} />;
  }
}

/** `id` of the <main> element: the skip link's target. */
const MAIN_ID = 'main-content';

/**
 * Application shell. Root structure, in DOM order:
 *
 *   skip link
 *   <aside>      desktop sidebar (lg and up)
 *   drawer       the same navigation as a slide-over (below lg)
 *   main column  <Topbar>, then <main id="main-content"> with the active view
 *   <BottomBar>  section tab bar (below md)
 *   <Toaster>
 */
export function App() {
  const { pathname, tab, rest, navigate, replace } = useAppRoute();
  const activeTab: Tab = tab ?? DEFAULT_TAB;
  const setActiveTab = (next: Tab, ...nextRest: string[]) => navigate(next, ...nextRest);
  const [menuOpen, setMenuOpen] = useState(false);
  const [navigationPreferences, setNavigationPreferences] = useState<NavigationPreferences>(
    DEFAULT_NAVIGATION_PREFERENCES,
  );

  // Client-only, once, after hydration completes: applies the real stored/OS
  // theme preference (see store/theme.ts's module docstring for why this
  // can't happen during render/SSR without crashing hydration).
  useEffect(() => {
    hydrateThemeFromStorage();
    hydrateSettingsFromStorage();
    hydrateRegimeCutsFromStorage();
    const stored = loadNavigationPreferences();
    setNavigationPreferences(stored);
  }, []);

  // An alias (an old or planned path, see PATH_ALIASES) already renders its view; this puts
  // the canonical path in the address bar, keeping any query string and hash.
  useEffect(() => {
    const target = aliasTarget(pathname);
    if (target) {
      window.history.replaceState(
        null,
        '',
        `${target}${window.location.search}${window.location.hash}`,
      );
    }
  }, [pathname]);

  useEffect(() => {
    document.title = documentTitle(activeTab, tab ? rest : []);
  }, [activeTab, tab, rest]);

  // "/" and unknown paths land on the default tab (a legacy shared Momentum link, which used
  // to be "/#momentum-cfg=…", keeps its hash and opens Momentum). A tab the user has hidden
  // falls back to the first visible one.
  useEffect(() => {
    if (!tab) {
      if (window.location.hash.startsWith('#momentum-cfg=')) {
        window.location.replace(`/momentum/backtest${window.location.hash}`);
      } else {
        // Settings › Defaults › Landing tab, unless that tab has since been hidden.
        const landing = getLandingTab();
        replace(
          landing && !navigationPreferences.hidden.includes(landing)
            ? landing
            : firstVisibleTab(navigationPreferences),
        );
      }
    } else if (navigationPreferences.hidden.includes(tab)) {
      replace(firstVisibleTab(navigationPreferences));
    }
  }, [tab, navigationPreferences, replace]);

  function updateNavigationPreferences(nextValue: NavigationPreferences): void {
    const next = normalizeNavigationPreferences(nextValue);
    setNavigationPreferences(next);
    saveNavigationPreferences(next);
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* First focusable element. Focuses <main> directly rather than following the hash,
          so the URL (which may carry a shared Momentum config in its hash) is untouched. */}
      <a
        href={`#${MAIN_ID}`}
        onClick={(event) => {
          event.preventDefault();
          document.getElementById(MAIN_ID)?.focus();
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow-elevated focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-border bg-surface/50 lg:block">
        <Sidebar
          activeTab={activeTab}
          activeRest={rest}
          onSelect={setActiveTab}
          preferences={navigationPreferences}
        />
      </aside>

      {/* Mobile nav drawer */}
      <Dialog.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm data-[state=open]:animate-fade-in lg:hidden" />
          <Dialog.Content className="fixed inset-y-0 left-0 z-50 w-64 border-r border-border bg-surface shadow-elevated focus:outline-none data-[state=open]:animate-fade-in lg:hidden">
            <Dialog.Title className="sr-only">Navigation</Dialog.Title>
            <Sidebar
              activeTab={activeTab}
              activeRest={rest}
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
        <TokenBanner />
        {/* Bottom padding below md clears the fixed BottomBar. */}
        <main
          id={MAIN_ID}
          tabIndex={-1}
          className="mx-auto max-w-7xl px-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] pt-6 focus:outline-none sm:px-6 md:pb-6"
        >
          <div key={activeTab} className="animate-fade-in">
            {renderView(activeTab, navigationPreferences, updateNavigationPreferences)}
          </div>
        </main>
      </div>

      <BottomBar
        activeTab={activeTab}
        onSelect={setActiveTab}
        preferences={navigationPreferences}
        onOpenMenu={() => setMenuOpen(true)}
        menuOpen={menuOpen}
      />
      <Toaster />
    </div>
  );
}
