import type { Locator } from 'playwright';
import type { Broker } from './automation-settings.js';
import { BROKER_LABELS, checkBrokerSheet } from './deploy-plan.js';

/**
 * Tick exactly the wanted brokers in the open broker sheet (BL-197) and set each one's Quantity
 * Multiplier (BL-209 Phase 3). Each row's checkbox is read-only and the row takes the click; every
 * box and every quantity is read back, so a click that missed stops the run before Activate.
 */
export async function tickBrokers(
  sheet: Locator,
  lots: ReadonlyMap<Broker, number>,
): Promise<void> {
  const brokers = [...lots.keys()];
  const check = checkBrokerSheet(await sheet.innerText(), brokers);
  if (check.missing.length) throw new Error(`broker sheet lists no ${check.missing.join(', ')}`);
  if (check.notLoggedIn.length)
    throw new Error(`${check.notLoggedIn.join(', ')} not LOGGED IN on the broker sheet`);
  const byLabel = new Map(brokers.map((b) => [BROKER_LABELS[b] ?? b, lots.get(b) ?? 1]));
  const boxes = sheet.locator('input[type=checkbox][readonly]');
  for (let i = 0; i < (await boxes.count()); i++) {
    const box = boxes.nth(i);
    const row = box.locator('xpath=..');
    const label = (await row.innerText()).trim();
    const brokerLabel = [...byLabel.keys()].find((w) => label.startsWith(`${w} - `));
    const want = brokerLabel !== undefined;
    const checked = () => box.evaluate((e) => (e as HTMLInputElement).checked);
    if ((await checked()) !== want) await row.click();
    if ((await checked()) !== want)
      throw new Error(`could not ${want ? 'tick' : 'untick'} "${label}" on the broker sheet`);
    if (brokerLabel !== undefined)
      await setQuantity(box, brokerLabel, byLabel.get(brokerLabel) ?? 1);
  }
  const ticked = await boxes.evaluateAll(
    (els) => els.filter((e) => (e as HTMLInputElement).checked).length,
  );
  if (ticked !== byLabel.size)
    throw new Error(`${ticked} broker(s) ticked on the broker sheet, expected ${byLabel.size}`);
}

/**
 * The ticked broker's card ("Quantity Multiplier: 1 x [- n +] = n", seen 2026-11-06 in the
 * owner's session): step the number with its own Increase / Decrease buttons until it reads
 * `want`, then check the card's total says the same.
 */
async function setQuantity(box: Locator, label: string, want: number): Promise<void> {
  const card = box.locator('xpath=ancestor::div[contains(@class,"grid-cols-4")][1]');
  const input = card.locator('input[type=number]');
  await input.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {
    throw new Error(`no Quantity Multiplier shown for ${label} on the broker sheet`);
  });
  let have = Number(await input.inputValue());
  if (!Number.isInteger(have) || have < 1)
    throw new Error(`${label}'s quantity reads "${await input.inputValue()}" on the broker sheet`);
  for (let step = 0; have !== want; step++) {
    if (step >= 20) throw new Error(`could not set ${label}'s quantity to ${want}`);
    await card
      .getByRole('button', { name: have < want ? 'Increase' : 'Decrease', exact: true })
      .click();
    const next = Number(await input.inputValue());
    if (next === have) throw new Error(`${label}'s quantity did not move from ${have}`);
    have = next;
  }
  const text = (await card.innerText()).replace(/\s+/g, ' ');
  if (!new RegExp(`= ${want}(?!\\d)`).test(text))
    throw new Error(
      `${label}'s card does not total ${want} after setting it: "${text.slice(0, 120)}"`,
    );
}
