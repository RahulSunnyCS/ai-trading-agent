'use client';

import { type RefObject, useEffect, useState } from 'react';

/** "Near the screen": within one screen height of the viewport. */
const NEAR_MARGIN = '100% 0px 100% 0px';

/**
 * When a below-the-fold widget should mount its content (the Analytics page pattern's progressive
 * loading). True once the widget comes within about one screen of the viewport, or, given
 * `prefetchAfterMs`, once that long has passed after mount and the browser is idle, whichever
 * is first. Once true it stays true. A widget whose content fetches on mount (`useRunSection`)
 * therefore loads in the background in its prefetch order, or straight away when scrolled to;
 * one with `prefetchAfterMs` null (an expensive section) waits for the scroll.
 *
 * Without IntersectionObserver (a test environment, an old browser) it is true at once.
 */
export function useWidgetActivation(
  ref: RefObject<Element>,
  { prefetchAfterMs = null }: { prefetchAfterMs?: number | null } = {},
): boolean {
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (active) return;
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setActive(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setActive(true);
      },
      { rootMargin: NEAR_MARGIN },
    );
    observer.observe(node);

    let timer: ReturnType<typeof setTimeout> | null = null;
    let idle: number | null = null;
    if (prefetchAfterMs !== null) {
      timer = setTimeout(() => {
        if (typeof window.requestIdleCallback === 'function') {
          idle = window.requestIdleCallback(() => setActive(true), { timeout: 2000 });
        } else {
          setActive(true);
        }
      }, prefetchAfterMs);
    }
    return () => {
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
      if (idle !== null && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idle);
      }
    };
  }, [active, ref, prefetchAfterMs]);

  return active;
}
