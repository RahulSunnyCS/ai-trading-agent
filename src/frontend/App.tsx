import { useState } from 'react';

import { BackfillView } from './components/BackfillView';
import { LiveView } from './components/LiveView';
import { PaymentTestModeBanner } from './components/PaymentTestModeBanner';
import { PnlView } from './components/PnlView';
import { PricingPage } from './components/PricingPage';
import { RegimeView } from './components/RegimeView';
import { TradesView } from './components/TradesView';

/**
 * The six dashboard tabs. 'pnl' is rendered as "P&L" in the nav.
 * 'regime' and 'backfill' are the two Milestone-3 additions.
 */
type Tab = 'live' | 'pnl' | 'pricing' | 'trades' | 'regime' | 'backfill';

/**
 * Returns a human-readable label for each tab.
 * Centralises the special-cases for 'pnl' and multi-word tabs so the nav map
 * stays clean.
 */
function tabLabel(tab: Tab): string {
  if (tab === 'pnl') return 'P&L';
  if (tab === 'regime') return 'Regimes';
  if (tab === 'backfill') return 'Backfill';
  // Capitalise first letter; remaining tabs are single words so slice(1) is safe.
  // 'pricing' → "Pricing", 'live' → "Live", 'trades' → "Trades"
  return tab.charAt(0).toUpperCase() + tab.slice(1);
}

/**
 * Root application shell.
 * Renders a header, tab navigation, and the active tab content.
 * PaymentTestModeBanner is always mounted — it self-hides in live mode.
 */
export function App() {
  const [activeTab, setActiveTab] = useState<Tab>('live');

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4">
        <h1 className="text-xl font-bold text-white">AI Trading Agent</h1>
        <PaymentTestModeBanner />
      </header>

      <nav className="flex gap-1 border-b border-gray-800 px-6">
        {(['live', 'trades', 'pnl', 'pricing', 'regime', 'backfill'] as Tab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-3 text-sm font-medium capitalize transition-colors ${
              activeTab === tab
                ? 'border-b-2 border-blue-500 text-blue-400'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            {tabLabel(tab)}
          </button>
        ))}
      </nav>

      <main className="p-6">
        {activeTab === 'live' && <LiveView />}
        {activeTab === 'trades' && <TradesView />}
        {activeTab === 'pnl' && <PnlView />}
        {activeTab === 'pricing' && <PricingPage />}
        {activeTab === 'regime' && <RegimeView />}
        {activeTab === 'backfill' && <BackfillView />}
      </main>
    </div>
  );
}
