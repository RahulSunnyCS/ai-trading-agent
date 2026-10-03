'use client';

import { App } from '../../App';

/** Optional catch-all: every dashboard path renders the shell, which reads the URL itself. */
export default function DashboardPage() {
  return <App />;
}
