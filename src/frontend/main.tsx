import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Side-effect import: injects Tailwind base/components/utilities into the page.
import './index.css';

import { App } from './App';

/**
 * Vite entry point. Guards against a null #root to satisfy strictNullChecks —
 * the guard is a programmer-error fence, not a user-facing code path.
 */
const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
