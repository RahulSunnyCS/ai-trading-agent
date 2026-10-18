import { mkdir, writeFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import { redact } from './secrets.js';

export const ARTIFACTS_DIR = 'artifacts';

let counter = 0;

/**
 * Settles within `ms` whatever `promise` does: a hung page (page.evaluate and page.content take no
 * timeout) must never hold a diagnostic, and with it the run, open.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function slug(label: string): string {
  counter += 1;
  const safe = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${String(counter).padStart(2, '0')}-${safe}`.slice(0, 80);
}

/**
 * Blanks every input before capturing, so a screenshot taken mid-login can never
 * leak a filled-in password or TOTP code into a build artifact.
 */
export async function safeScreenshot(page: Page, label: string): Promise<void> {
  try {
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    await withTimeout(
      page.evaluate(() => {
        for (const input of Array.from(document.querySelectorAll('input'))) {
          if (input.type === 'checkbox' || input.type === 'radio') continue;
          input.value = '';
          input.setAttribute('value', '');
        }
      }),
      5_000,
      'blanking inputs',
    ).catch(() => undefined);
    await page.screenshot({
      path: `${ARTIFACTS_DIR}/${slug(label)}.png`,
      fullPage: true,
      timeout: 10_000,
    });
  } catch (error) {
    console.error(`  could not capture screenshot for "${label}":`, describe(error));
  }
}

export async function dumpHtml(page: Page, label: string): Promise<void> {
  try {
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    const html = await withTimeout(page.content(), 10_000, 'reading the page HTML');
    await writeFile(`${ARTIFACTS_DIR}/${slug(label)}.html`, redact(html), 'utf8');
  } catch (error) {
    console.error(`  could not dump HTML for "${label}":`, describe(error));
  }
}

export function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redact(message.split('\n').slice(0, 4).join(' '));
}

/**
 * Wraps an interaction so a missing selector always produces a screenshot and an HTML
 * dump before the error propagates. Rethrows the original error so callers can still
 * inspect its type.
 */
export async function step<T>(page: Page, label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    console.error(`  step failed: ${label} -> ${describe(error)}`);
    await safeScreenshot(page, `fail-${label}`);
    await dumpHtml(page, `fail-${label}`);
    throw error;
  }
}
