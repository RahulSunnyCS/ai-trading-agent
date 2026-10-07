import type { MouseEvent } from 'react';

import { glossaryAnchor } from '../../guide/glossary';
import { buildPath } from '../../lib/routes';

/** A plain left click, which the app handles itself; modified clicks behave as normal links. */
export function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** The Glossary page's URL, optionally at one term. */
export function glossaryHref(id?: string): string {
  const path = buildPath('guide', 'glossary', 'terms');
  return id ? `${path}#${glossaryAnchor(id)}` : path;
}

/** Pushes the Glossary page with `#term-<id>` and scrolls to it once it is on screen. */
export function openGlossaryTerm(id: string): void {
  window.history.pushState(null, '', glossaryHref(id));
  // Already on the Glossary page: nothing re-renders, so scroll now. Otherwise GuideView
  // scrolls to the hash once the page has rendered.
  window.setTimeout(
    () => document.getElementById(glossaryAnchor(id))?.scrollIntoView({ block: 'start' }),
    0,
  );
}
