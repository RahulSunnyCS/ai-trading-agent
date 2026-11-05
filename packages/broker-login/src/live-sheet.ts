import type { Page } from 'playwright';
import type { Pick } from './deploy-plan.js';
import { dumpHtml, safeScreenshot } from './diagnose.js';
import { livePage } from './selectors.js';

/** "HH:MM" of minutes after midnight. */
export function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** `saved`: a first setup, checked and saved. `kept`: set up before, checked and closed unsaved. */
export type SheetOutcome = 'saved' | 'kept';

/**
 * Open the pick's execution sheet on /live. A first setup ("Setup Execution Settings") checks
 * AlgoTest's defaults, puts Trade monitoring on Candle Close (BL-197: the overall MTM stop then
 * checks at each minute's close, as the backtest does; leg stops stay on LTP) and saves it.
 *
 * A sheet set up before ("Update Execution Settings", 2026-11-05: last evening's setup, reopened
 * by the 08:11 activation) shows the multiplier and the execution time empty, so only what the
 * setup decided is checked, Candle Close and no execution day ticked, and the sheet is closed with
 * Cancel, never saved again.
 */
export async function setupSheet(page: Page, pick: Pick): Promise<SheetOutcome> {
  const { name } = pick;
  await livePage.row(page, name).click();
  await livePage.setupExecution(page).click();
  const sheet = livePage.sheet(page, name);
  await sheet.waitFor({ timeout: 15_000 });

  try {
    // no execution day ticked, so the deploy is for today only
    const ticked = await sheet
      .locator('input[type=checkbox]')
      .evaluateAll((els) => els.filter((e) => (e as HTMLInputElement).checked).length);
    if (ticked > 0) throw new Error(`${ticked} box(es) ticked in the sheet; expected none`);
    const candle = livePage.monitoring(sheet, 'on Candle Close');
    const radio = candle.locator('input[type=radio]');

    const saveLabel = (await livePage.sheetSave(sheet).innerText()).trim();
    if (saveLabel.startsWith('Update')) {
      if (!(await radio.isChecked()))
        throw new Error(
          'set up before, but Trade monitoring is not on Candle Close: set it on /live by hand',
        );
      await livePage.sheetCancel(sheet).click();
      await sheet.waitFor({ state: 'hidden', timeout: 15_000 });
      return 'kept';
    }

    // AlgoTest's defaults, checked inside the sheet rather than changed: 1 lot, NRML on every leg.
    const multiplier = await sheet.locator('input[type=number]').first().inputValue();
    if (multiplier !== '1') throw new Error(`quantity multiplier is ${multiplier}, not 1`);
    const products = await sheet
      .locator('select')
      .evaluateAll((els) =>
        els.map((e) => (e as HTMLSelectElement).value).filter((v) => v.startsWith('ProductType.')),
      );
    if (!products.length || products.some((v) => v !== 'ProductType.NRML'))
      throw new Error(`leg product types ${products.join(', ')}, expected NRML`);
    const time = (await livePage.executionTime(sheet).inputValue()).slice(0, 5);
    if (time !== hhmm(pick.entry))
      throw new Error(`strategy execution time ${time}, expected ${hhmm(pick.entry)}`);
    if (!(await radio.isChecked())) await candle.click();
    if (!(await radio.isChecked()))
      throw new Error('Trade monitoring did not switch to on Candle Close');
  } catch (error) {
    // the sheet as refused is kept for diagnosis, then closed unsaved, so it does not cover the
    // next pick's row
    await safeScreenshot(page, 'sheet-refused');
    await dumpHtml(page, 'sheet-refused');
    await livePage
      .sheetCancel(sheet)
      .click({ timeout: 5_000 })
      .catch(() => undefined);
    throw error;
  }

  await livePage.sheetSave(sheet).click();
  await sheet.waitFor({ state: 'hidden', timeout: 15_000 });
  return 'saved';
}
