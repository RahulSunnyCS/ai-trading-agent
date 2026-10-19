import type { Locator } from 'playwright';

/**
 * True once `locator` is visible, false if it is not within `ms`. Playwright's
 * `isVisible({ timeout })` does not wait (the option is ignored), so a check made right after a
 * `goto` sees a page that has not rendered yet; this waits up to `ms` instead.
 */
export function visibleWithin(locator: Locator, ms: number): Promise<boolean> {
  return locator.waitFor({ state: 'visible', timeout: ms }).then(
    () => true,
    () => false,
  );
}
