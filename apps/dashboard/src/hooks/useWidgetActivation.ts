'use client';

import { type RefObject, useEffect, useState } from 'react';

/** "Near the screen": within one screen height of the viewport. */
export const NEAR_MARGIN = '100% 0px 100% 0px';

export interface WidgetActivationOptions {
  /** Background-load this long after `ready`, once the browser is idle; null = only on scroll. */
  prefetchAfterMs?: number | null;
  /** How far outside the viewport counts as "near" (an IntersectionObserver `rootMargin`). */
  margin?: string;
  /** False holds everything back: nothing activates until the hero chart has painted. */
  ready?: boolean;
  /** A section that costs a second engine run: without IntersectionObserver it stays
   * inactive instead of loading at once, since nothing can tell it was scrolled to. */
  expensive?: boolean;
}

/**
 * When a below-the-fold widget should mount its content (the Analytics page pattern's progressive
 * loading). True once the widget comes within `margin` (about one screen) of the viewport, or,
 * given `prefetchAfterMs`, once that long has passed and the browser is idle, whichever is
 * first. Neither starts before `ready` (the hero chart has painted, so the widgets do not
 * compete with it). Once true it stays true. A widget whose content fetches on mount (`useRunSection`)
 * therefore loads in the background in its prefetch order, or straight away when scrolled to;
 * one with `prefetchAfterMs` null (an expensive section) waits for the scroll.
 *
 * Without IntersectionObserver (a test environment, an old browser) it is true at once, except
 * for an `expensive` section.
 */
export function useWidgetActivation(
  ref: RefObject<Element>,
  {
    prefetchAfterMs = null,
    margin = NEAR_MARGIN,
    ready = true,
    expensive = false,
  }: WidgetActivationOptions = {},
): boolean {
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (active || !ready) return;
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      if (!expensive) setActive(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setActive(true);
      },
      { rootMargin: margin },
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
  }, [active, ready, ref, prefetchAfterMs, margin, expensive]);

  return active;
}
