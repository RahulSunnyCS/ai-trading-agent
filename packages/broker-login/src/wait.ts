import { type Locator, errors } from 'playwright';

/**
 * True once `locator` is visible, false if it is not within `ms`. Playwright's
 * `isVisible({ timeout })` does not wait (the option is ignored), so a check made right after a
 * `goto` sees a page that has not rendered yet; this waits up to `ms` instead. Only a timeout
 * means "not visible": any other error (a locator matching two elements, a closed page) is thrown,
 * so a safety check never reads a broken locator as "nothing there".
 */
export async function visibleWithin(locator: Locator, ms: number): Promise<boolean> {
  try {
    await locator.waitFor({ state: 'visible', timeout: ms });
    return true;
  } catch (error) {
    if (error instanceof errors.TimeoutError) return false;
    throw error;
  }
}
