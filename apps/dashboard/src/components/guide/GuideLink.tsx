import { BookOpen } from 'lucide-react';

import { guidePageForScreen, guidePath } from '../../guide/registry';
import { useAppRoute } from '../../hooks/useAppRoute';
import { cn } from '../../lib/cn';
import type { Tab } from '../shell/nav';
import { isPlainClick } from './links';

/**
 * "How this works": opens the guide page that documents a screen. The page is looked up in the
 * Guide's registry by tab and sub-section, so the link cannot point at a page that is gone;
 * a screen with no page renders nothing.
 */
export function GuideLink({
  tab,
  rest = [],
  className,
}: {
  tab: Tab;
  /** The path segments after the tab, as on screen. */
  rest?: readonly string[];
  className?: string;
}) {
  const { navigate } = useAppRoute();
  const page = guidePageForScreen(tab, rest);
  if (!page) return null;
  return (
    <a
      href={guidePath(page)}
      title={`Guide: ${page.title}`}
      className={cn(
        'inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        navigate('guide', page.chapter, page.slug);
      }}
    >
      <BookOpen className="h-4 w-4" aria-hidden="true" />
      <span className="hidden sm:inline">How this works</span>
      <span className="sr-only sm:hidden">How this works</span>
    </a>
  );
}
