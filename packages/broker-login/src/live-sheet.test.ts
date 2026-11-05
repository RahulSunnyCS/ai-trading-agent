import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type Browser, type Page, chromium } from 'playwright';
import { hhmm, setupSheet } from './live-sheet.js';

/**
 * Real Chromium against a stand-in /live: a row, its "Edit Execution" button and the execution
 * sheet, shaped as AlgoTest showed it (2026-11-05 screenshot: "Edit execution for <name>", hidden
 * radios inside the Trade monitoring labels, Cancel beside the save button). Skipped where no
 * browser is installed.
 */
let browser: Browser | null = null;
let skip: string | false = false;

before(async () => {
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    skip = `no Chromium available: ${error instanceof Error ? error.message.split('\n')[0] : error}`;
  }
});
after(async () => {
  await browser?.close();
});

const NAME = 'Core · S_dir_0932';
const PICK = { name: NAME, entry: 9 * 60 + 32 };

interface Sheet {
  save: 'Setup' | 'Update';
  candle: boolean;
  multiplier: string;
  time: string;
  dayTicked?: boolean;
}

function livePageHtml(s: Sheet): string {
  return `
  <p>${NAME}</p>
  <button onclick="document.getElementById('sheet').style.display='block'">Edit Execution</button>
  <div id="sheet" style="display:none">
    <div>
      <p>Edit execution for ${NAME}</p>
      <input type="number" value="${s.multiplier}">
      <label><input hidden type="radio" name="m" value="on LTP" ${s.candle ? '' : 'checked'}>on LTP</label>
      <label><input hidden type="radio" name="m" value="on Candle Close" ${s.candle ? 'checked' : ''}>on Candle Close</label>
      <input type="time" value="${s.time}">
      <select><option value="ProductType.NRML" selected>NRML</option></select>
      <input hidden type="checkbox" value="1" ${s.dayTicked ? 'checked' : ''}>
      <button onclick="document.getElementById('sheet').style.display='none'">Cancel</button>
      <button onclick="window.saved=(window.saved||0)+1;document.getElementById('sheet').style.display='none'">${s.save} Execution Settings</button>
    </div>
  </div>`;
}

async function open(s: Sheet): Promise<Page> {
  assert.ok(browser);
  const p = await (await browser.newContext()).newPage();
  p.setDefaultTimeout(3_000);
  await p.setContent(livePageHtml(s));
  return p;
}

const saves = (p: Page) => p.evaluate(() => (window as unknown as { saved?: number }).saved ?? 0);

describe('setupSheet', () => {
  it('hhmm pads hours and minutes', () => {
    assert.equal(hhmm(9 * 60 + 2), '09:02');
    assert.equal(hhmm(12 * 60 + 17), '12:17');
  });

  it('a sheet set up before: checks Candle Close, closes with Cancel, never saves', async (t) => {
    if (skip) return t.skip(skip);
    // the 2026-11-05 sheet: multiplier and time shown empty
    const p = await open({ save: 'Update', candle: true, multiplier: '', time: '' });
    assert.equal(await setupSheet(p, PICK), 'kept');
    assert.equal(await saves(p), 0);
    assert.equal(await p.locator('#sheet').isVisible(), false);
  });

  it('a sheet set up before on LTP is refused, not saved', async (t) => {
    if (skip) return t.skip(skip);
    const p = await open({ save: 'Update', candle: false, multiplier: '', time: '' });
    await assert.rejects(setupSheet(p, PICK), /not on Candle Close/);
    assert.equal(await saves(p), 0);
  });

  it('a sheet set up before with a day ticked is refused', async (t) => {
    if (skip) return t.skip(skip);
    const p = await open({
      save: 'Update',
      candle: true,
      multiplier: '',
      time: '',
      dayTicked: true,
    });
    await assert.rejects(setupSheet(p, PICK), /1 box\(es\) ticked/);
    assert.equal(await saves(p), 0);
  });

  it('a first setup: checks the defaults, switches to Candle Close and saves', async (t) => {
    if (skip) return t.skip(skip);
    const p = await open({ save: 'Setup', candle: false, multiplier: '1', time: '09:32' });
    assert.equal(await setupSheet(p, PICK), 'saved');
    assert.equal(await saves(p), 1);
    assert.equal(await p.locator('input[value="on Candle Close"]').isChecked(), true);
  });

  it('a first setup still refuses a multiplier other than 1', async (t) => {
    if (skip) return t.skip(skip);
    const p = await open({ save: 'Setup', candle: false, multiplier: '2', time: '09:32' });
    await assert.rejects(setupSheet(p, PICK), /quantity multiplier is 2/);
    assert.equal(await saves(p), 0);
  });

  it('a first setup still refuses a wrong execution time', async (t) => {
    if (skip) return t.skip(skip);
    const p = await open({ save: 'Setup', candle: false, multiplier: '1', time: '09:47' });
    await assert.rejects(setupSheet(p, PICK), /execution time 09:47, expected 09:32/);
  });
});
