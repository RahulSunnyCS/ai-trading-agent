import type { Page, Response } from 'playwright';

/**
 * Open /live and wait until the page has received the account's deployments.
 *
 * The Activation rows render before that, each reading "0 Deployed", and a click made then does
 * nothing. Reading or clicking at that point gave "/live shows 0 Deployed after Activate" for a
 * deploy that had gone through (2026-11-25) and "Activate did not open the broker sheet"
 * (2026-11-27). The call is the one the Deployed Strategies cards are drawn from
 * (docs/algotest-execution.md, "Live results"). If it never answers, this throws: nothing is read
 * from a page that has not loaded.
 */
export async function openLive(page: Page, url: string, timeout = 30_000): Promise<void> {
  const deployments = page.waitForResponse(isDeploymentsAnswer, { timeout });
  // the navigation may fail first: the wait must not then reject unhandled
  deployments.catch(() => undefined);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await deployments;
  // the answer is drawn a moment after it arrives
  await page.waitForTimeout(RENDER_MS);
}

export const RENDER_MS = 1_500;

export function isDeploymentsAnswer(response: Pick<Response, 'url' | 'ok'>): boolean {
  const url = new URL(response.url());
  return (
    url.pathname.endsWith('/execution/v2/executions') &&
    url.searchParams.get('environment') === 'live' &&
    response.ok()
  );
}
