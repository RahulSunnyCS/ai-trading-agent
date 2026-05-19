import { useState } from 'react';

import { LiveView } from './components/LiveView';
import { PaymentTestModeBanner } from './components/PaymentTestModeBanner';
import { PnlView } from './components/PnlView';
import { TradesView } from './components/TradesView';

/**
 * The three dashboard tabs. 'pnl' is rendered as "P&L" in the nav.
 */
type Tab = 'live' | 'pnl' | 'trades';

/**
 * Returns a human-readable label for each tab.
 * Centralises the special-case for 'pnl' so the nav map stays clean.
 */
function tabLabel(tab: Tab): string {
  if (tab === 'pnl') return 'P&L';
  // Capitalise first letter; remaining tabs are single words so slice(1) is safe.
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
        {(['live', 'trades', 'pnl'] as Tab[]).map((tab) => (
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
      </main>
    </div>
  );
}
