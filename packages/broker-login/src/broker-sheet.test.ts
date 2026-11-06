import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type Browser, type Page, chromium } from 'playwright';
import { tickBrokers } from './broker-sheet.js';

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
  for (const card of document.querySelectorAll('.grid-cols-4')) {
    const row = card.querySelector('.row'); const box = card.querySelector('input[type=checkbox]');
    row.addEventListener('click', (e) => {
      if (e.target.closest('.qty')) return;
      box.checked = !box.checked;
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
    });
  }
</script>`;

async function open(stuck = false): Promise<Page> {
  assert.ok(browser);
  const p = await (await browser.newContext()).newPage();
  p.setDefaultTimeout(3_000);
  await p.setContent(SHEET.replace('%STUCK%', String(stuck)));
  return p;
}

const quantity = (p: Page, broker: string) =>
  p.locator(`[data-b="${broker}"] input[type=number]`).inputValue();

describe('tickBrokers with quantities', () => {
  it("ticks the wanted accounts and sets each one's quantity", { skip }, async () => {
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

  it('leaves the other account unticked', { skip }, async () => {
    const p = await open();
    await tickBrokers(p.locator('#sheet'), new Map([['angelone', 2]]));
    assert.equal(await quantity(p, 'Angel One'), '2');
    assert.equal(await p.locator('[data-b="Finvasia"] input[type=number]').count(), 0);
    await p.context().close();
  });

  it('stops when the quantity will not move', { skip }, async () => {
    const p = await open(true);
    await assert.rejects(
      tickBrokers(p.locator('#sheet'), new Map([['finvasia', 2]])),
      /did not move from 1/,
    );
    await p.context().close();
  });
});
