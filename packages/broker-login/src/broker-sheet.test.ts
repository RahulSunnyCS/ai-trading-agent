import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type Browser, type Page, chromium } from 'playwright';
import { activateLabelIsFor, tickBrokers } from './broker-sheet.js';

/**
 * Real Chromium against a stand-in of AlgoTest's "Select Broker for <name>" sheet, shaped as the
 * owner's session showed it on 2026-11-06 (read from the DOM): each broker a `grid grid-cols-4`
 * card with a read-only checkbox row, and once ticked a "Quantity Multiplier: 1 x [− n +] = n"
 * block with Decrease / Increase buttons and a number input (min 1). Skipped where no browser
 * is installed.
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

const SHEET = `
<div id="sheet"><p>Select Broker for T1 · N_p80_1002</p>
  <div class="flex">
    <div class="grid grid-cols-4 gap-4 cursor-pointer" data-b="Angel One">
      <div class="row"><input type="checkbox" readonly><div>Angel One - Rahul</div><div>LOGGED IN</div></div>
    </div>
    <div class="grid grid-cols-4 gap-4 cursor-pointer" data-b="Finvasia">
      <div class="row"><input type="checkbox" readonly><div>Finvasia - Shiny</div><div>LOGGED IN</div></div>
    </div>
  </div>
  <button>Cancel</button><button id="go">Activate</button>
</div>
<script>
  window.stuck = %STUCK%;
  window.lag = %LAG%;   // ms before a click shows in the box (the page commits it later)
  window.swallow = %SWALLOW%; // clicks on the first row that do nothing
  for (const card of document.querySelectorAll('.grid-cols-4')) {
    const row = card.querySelector('.row'); const box = card.querySelector('input[type=checkbox]');
    const toggle = () => { box.checked = !box.checked; };
    row.addEventListener('click', (e) => {
      if (e.target.closest('.qty')) return;
      if (window.swallow > 0 && card.dataset.b === 'Finvasia') { window.swallow--; return; }
      if (window.lag) { setTimeout(() => { toggle(); render(); }, window.lag); return; }
      toggle(); render();
    });
    const render = () => {
      let q = card.querySelector('.qty');
      if (box.checked && !q) {
        q = document.createElement('div'); q.className = 'order-last qty';
        q.innerHTML = '<div class="flex"><span>Quantity Multiplier: 1 x</span><button aria-label="Decrease">-</button><input type="number" title="number" min="1" value="1"><button aria-label="Increase">+</button><span class="tot">= 1</span></div>';
        card.appendChild(q);
        const i = q.querySelector('input'); const t = q.querySelector('.tot');
        const set = (n) => { if (window.stuck) return; i.value = String(Math.max(1, n)); t.textContent = '= ' + i.value; };
        q.querySelector('[aria-label=Increase]').onclick = () => set(Number(i.value) + 1);
        q.querySelector('[aria-label=Decrease]').onclick = () => set(Number(i.value) - 1);
      }
      if (!box.checked && q) q.remove();
    };
  }
</script>`;

async function open(stuck = false, lag = 0, swallow = 0): Promise<Page> {
  assert.ok(browser);
  const p = await (await browser.newContext()).newPage();
  p.setDefaultTimeout(3_000);
  await p.setContent(
    SHEET.replace('%STUCK%', String(stuck))
      .replace('%LAG%', String(lag))
      .replace('%SWALLOW%', String(swallow)),
  );
  return p;
}

const quantity = (p: Page, broker: string) =>
  p.locator(`[data-b="${broker}"] input[type=number]`).inputValue();

describe('tickBrokers with quantities', () => {
  it("ticks the wanted accounts and sets each one's quantity", async (t) => {
    if (skip) return t.skip(skip);
    const p = await open();
    await tickBrokers(
      p.locator('#sheet'),
      new Map([
        ['finvasia', 2],
        ['angelone', 1],
      ]),
    );
    assert.equal(await quantity(p, 'Finvasia'), '2');
    assert.equal(await quantity(p, 'Angel One'), '1');
    await p.context().close();
  });

  it('leaves the other account unticked', async (t) => {
    if (skip) return t.skip(skip);
    const p = await open();
    await tickBrokers(p.locator('#sheet'), new Map([['angelone', 2]]));
    assert.equal(await quantity(p, 'Angel One'), '2');
    assert.equal(await p.locator('[data-b="Finvasia"] input[type=number]').count(), 0);
    await p.context().close();
  });

  it('stops when the quantity will not move', async (t) => {
    if (skip) return t.skip(skip);
    const p = await open(true);
    await assert.rejects(
      tickBrokers(p.locator('#sheet'), new Map([['finvasia', 2]])),
      /did not move from 1/,
    );
    await p.context().close();
  });
});

describe('tickBrokers when the page is slow', () => {
  it('waits for a click the page commits late', async (t) => {
    if (skip) return t.skip(skip);
    const p = await open(false, 700);
    await tickBrokers(p.locator('#sheet'), new Map([['finvasia', 1]]));
    assert.equal(await quantity(p, 'Finvasia'), '1');
    await p.context().close();
  });

  it('clicks again when the first click did nothing, and never toggles it back', async (t) => {
    if (skip) return t.skip(skip);
    const p = await open(false, 0, 1);
    await tickBrokers(p.locator('#sheet'), new Map([['finvasia', 1]]));
    assert.equal(await p.locator('[data-b="Finvasia"] input[type=checkbox]').isChecked(), true);
    await p.context().close();
  });

  it('still stops when the box never ticks', async (t) => {
    if (skip) return t.skip(skip);
    const p = await open(false, 0, 5);
    await assert.rejects(
      tickBrokers(p.locator('#sheet'), new Map([['finvasia', 1]])),
      /could not tick "Finvasia - Shiny/,
    );
    await p.context().close();
  });
});

describe('activateLabelIsFor', () => {
  it('takes the plural AlgoTest shows for one broker, and the singular', () => {
    assert.ok(activateLabelIsFor('Activate on 1 Brokers', 1));
    assert.ok(activateLabelIsFor('Activate on 1 Broker', 1));
    assert.ok(activateLabelIsFor(' Activate on 2 Brokers ', 2));
  });
  it('refuses a count that is not the wanted one, or nothing ticked', () => {
    assert.ok(!activateLabelIsFor('Activate on 2 Brokers', 1));
    assert.ok(!activateLabelIsFor('Activate on 11 Brokers', 1));
    assert.ok(!activateLabelIsFor('Activate', 1));
  });
});
