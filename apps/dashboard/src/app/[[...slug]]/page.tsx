import type { Metadata } from 'next';

import { documentTitle, parsePath } from '../../lib/routes';
import { DashboardClient } from './DashboardClient';

/**
 * The title for the first paint, from the path. Later in-app navigation changes the URL
 * without a server round trip, so App.tsx keeps `document.title` in step from there.
 */
export async function generateMetadata({
  params,
}: { params: Promise<{ slug?: string[] }> }): Promise<Metadata> {
  const { slug } = await params;
  const { tab, rest } = parsePath(`/${(slug ?? []).join('/')}`);
  return { title: documentTitle(tab, rest) };
}

/** Optional catch-all: every dashboard path renders the shell, which reads the URL itself. */
export default function DashboardPage() {
  return <DashboardClient />;
}
