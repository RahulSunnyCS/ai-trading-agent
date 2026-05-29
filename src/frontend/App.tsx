import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';

import { BackfillView } from './components/BackfillView';
import { LiveView } from './components/LiveView';
import { PaymentTestModeBanner } from './components/PaymentTestModeBanner';
import { PersonalitiesView } from './components/PersonalitiesView';
import { PnlView } from './components/PnlView';
import { PricingPage } from './components/PricingPage';
import { RegimeView } from './components/RegimeView';
import { ReplayView } from './components/ReplayView';
import { TradesView } from './components/TradesView';
import { Sidebar } from './components/shell/Sidebar';
import { Topbar } from './components/shell/Topbar';
import { type Tab, tabLabel } from './components/shell/nav';

/** One-line subtitle shown under each view's title in the top bar. */
const SUBTITLES: Record<Tab, string> = {
  live: 'Real-time straddle, momentum, and feed status',
  trades: 'Simulated paper-trade log',
  personalities: 'The 10 decision engines and their configs',
  pnl: 'Realized P&L across closed paper trades',
  regime: 'Daily market-regime classification history',
  backfill: 'Historical tick-data ingestion coverage',
  replay: 'Deterministic replay of historical sessions',
  pricing: 'Subscription access and feature credits',
};

function renderView(tab: Tab) {
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
    case 'pricing':
      return <PricingPage />;
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

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-border bg-surface/50 lg:block">
        <Sidebar activeTab={activeTab} onSelect={setActiveTab} />
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
          onOpenMenu={() => setMenuOpen(true)}
        />
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
          <PaymentTestModeBanner />
          <div key={activeTab} className="animate-fade-in">
            {renderView(activeTab)}
          </div>
        </main>
      </div>
    </div>
  );
}
