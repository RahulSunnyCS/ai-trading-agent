import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sendText } from '@trading/notify';
import { chromium } from 'playwright';
import { describeSource, readAutomation, uploadBooks } from './automation-settings.js';
import { readTelegramConfig } from './config.js';
import { describe } from './diagnose.js';
import { installOverlayHandlers } from './overlays.js';
import { QuantiplyApi, readToken } from './quantiply-api.js';
import {
  type QLedgerRow,
  type QManifest,
  type QWanted,
  istWeekday,
  needsAttentionQ,
  parseQLedger,
  planQ,
  readBackDiffs,
  sessionOver,
  summaryQ,
  weekdayOf,
} from './quantiply-plan.js';
import { QUANTIPLY_SITES, parseQuantiplyBroker } from './quantiply-rules.js';
import { quantiplyShoonyaLogin } from './quantiply-shoonya.js';
import { quantiplyLogin } from './quantiply.js';
import { redact, registerSecret } from './secrets.js';
import { type Mode, istToday, sha256 } from './strategy-plan.js';

/**
 * BL-139 Phase 3: put the day's rotation picks into Quantiply as algos, through Quantiply's own
 * API (the calls its web app makes). Never enables (deploys) anything.
 *
 *   tsx src/quantiply-upload.ts [--broker angelone|finvasia] --from-settings | --latest <book> |
 *     --dir <export folder>  --mode evening|topup [--apply]
 *
 * BL-140: Quantiply has one account per broker (`--broker`, default angelone: Angel One's
 * app.quantiply.angelone.in; finvasia: Shoonya's quantiply.shoonya.com), each with its own login,
 * API host and ledger. `--from-settings` uploads the list the dashboard's Settings › Automation
 * gives that row (`automation-settings.json`); a row with no upload, or uploads switched off, is
 * left untouched: the run says so and changes nothing.
 *
 * `--dir` is a folder written by `obt rotation quantiply-export` (manifest.json + one `POST /algos`
 * body per pick, for the session's weekday). The run logs in through Angel One in a browser (the
 * same flow as the 08:00 login, `src/quantiply.ts`), takes the web app's token, closes the browser
 * and calls the API. Without `--apply` it reads the algo list and prints the plan, changing
 * nothing. `--apply` needs `QUANTIPLY_UPLOAD=on`. The ledger (`--ledger`, default
 * TRADING_DATA_ROOT/rotation/quantiply/ledger.jsonl) records every create and delete by algo id;
 * only algos in it are ever deleted. Each created algo is read back (`GET /algos/:id`) and compared
 * with what was sent; a difference is recorded and alerted.
 */

const READ_BACK_OK = 'read back: identical';

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string' },
      latest: { type: 'string' },
      mode: { type: 'string' },
      ledger: { type: 'string' },
      broker: { type: 'string' },
      'from-settings': { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
      headed: { type: 'boolean', default: false },
    },
  });
  if (values.mode !== 'evening' && values.mode !== 'topup') {
    console.error(
      'usage: [--broker angelone|finvasia] --from-settings | --latest <book> | --dir <folder>, --mode evening|topup [--apply]',
    );
    return 64;
  }
  if (existsSync('.env')) process.loadEnvFile('.env');
  if (values.apply && process.env.QUANTIPLY_UPLOAD?.trim().toLowerCase() !== 'on') {
    console.log(
      'QUANTIPLY_UPLOAD is not "on": nothing created or deleted (dry run without --apply)',
    );
    return 0;
  }
  // Evening mode replaces today's algos with tomorrow's: before 15:30 IST today's later picks may
  // still be waiting to be enabled, so it never runs then (Apply now, a manual run, a catch-up).
  if (values.mode === 'evening' && !sessionOver()) {
    console.error("evening mode runs only after 15:30 IST: today's picks may still trade");
    return 1;
  }
  const broker = parseQuantiplyBroker(values.broker);
  const site = QUANTIPLY_SITES[broker];
  const dataRoot = process.env.TRADING_DATA_ROOT?.trim();
  let exportDir = values.dir;
  let latest = values.latest;
  let decidedBy = '';
  if (values['from-settings']) {
    const automation = readAutomation();
    decidedBy = describeSource(automation);
    const books = uploadBooks(automation, 'quantiply', broker);
    if (!books.length) {
      console.log(`${site.name}: nothing to upload (${decidedBy}); nothing changed`);
      return 0;
    }
    latest = books[0];
  }
  if (!exportDir && latest) {
    if (!dataRoot) {
      console.error('--latest needs TRADING_DATA_ROOT');
      return 1;
    }
    exportDir = (
      await readJson<{ dir: string }>(
        join(dataRoot, 'rotation', 'quantiply', `latest-${latest}.json`),
      )
    ).dir;
  }
  if (!exportDir) {
    console.error('give --dir or --latest');
    return 64;
  }
  if (!values.ledger && !dataRoot) {
    console.error('the ledger lives under TRADING_DATA_ROOT: set it, or pass --ledger');
    return 1;
  }
  const mode = values.mode as Mode;
  const dir = resolve(exportDir);
  const ledgerPath = values.ledger
    ? resolve(values.ledger)
    : join(
        dataRoot ?? '',
        'rotation',
        'quantiply',
        // Angel One's keeps its original name; each other account has its own ledger.
        broker === 'angelone' ? 'ledger.jsonl' : `ledger-${broker}.jsonl`,
      );
  const manifest = await readJson<QManifest>(join(dir, 'manifest.json'));
  const today = istToday();
  const fits =
    mode === 'evening'
      ? manifest.source === 'preview' && manifest.day > today
      : manifest.source === 'recorded' && manifest.day === today;
  if (!fits) {
    console.error(
      `${mode}: the export is ${manifest.source} for ${manifest.day} (today ${today}); refusing`,
    );
    return 1;
  }
  if (weekdayOf(manifest.day) !== manifest.weekday) {
    console.error(`manifest: ${manifest.day} is not a ${manifest.weekday}; refusing`);
    return 1;
  }
  const bodies = new Map<string, Record<string, unknown>>();
  const wanted: QWanted[] = [];
  for (const s of manifest.strategies) {
    const file = join(dir, s.file);
    const text = await readFile(file, 'utf8');
    const body = JSON.parse(text) as Record<string, unknown>;
    if (JSON.stringify(body.day) !== JSON.stringify([manifest.weekday]) || body.name !== s.name) {
      console.error(`${s.file}: its name or day does not match the manifest; refusing`);
      return 1;
    }
    bodies.set(s.name, body);
    wanted.push({
      name: s.name,
      variant: s.variant,
      file,
      sha: sha256(text),
      unconfirmed: s.unconfirmed ?? [],
    });
  }
  const ledger = existsSync(ledgerPath) ? parseQLedger(await readFile(ledgerPath, 'utf8')) : [];

  const names =
    broker === 'angelone'
      ? ['ANGELONE_CLIENT_CODE', 'ANGELONE_MPIN', 'ANGELONE_TOTP_SECRET']
      : ['SHOONYA_CLIENT_ID', 'SHOONYA_PASSWORD', 'SHOONYA_TOTP_SECRET'];
  const [user, secret, totpSecret] = names.map((n) => process.env[n]?.trim() ?? '');
  if (!user || !secret || !totpSecret) {
    console.error(`${names.join(' / ')} missing from .env`);
    return 1;
  }
  registerSecret(secret);
  registerSecret(totpSecret);
  const telegram = readTelegramConfig();
  const when = mode === 'evening' ? 'evening' : '09:16 top-up';
  const label = `${site.name} ${manifest.book.toUpperCase()} ${when} for ${manifest.day} (${manifest.weekday})${decidedBy ? `, ${decidedBy}` : ''}`;
  const lines: string[] = [];
  let failed = false;
  let printed = 0; // lines already on the console (the plan), so the end prints only the rest

  try {
    // The browser is only for the login: the token is taken and the browser closed before any call.
    const browser = await chromium.launch({ headless: !values.headed });
    let token: string;
    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: 'en-IN',
        timezoneId: 'Asia/Kolkata',
      });
      installOverlayHandlers(context);
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      if (broker === 'angelone') {
        await quantiplyLogin(
          page,
          { clientCode: user, mpin: secret, totpSecret },
          { submitted: false },
        );
      } else {
        await quantiplyShoonyaLogin(page, { userId: user, password: secret, totpSecret });
      }
      token = await readToken(await context.newPage(), site);
    } finally {
      await browser.close().catch(() => undefined);
    }
    registerSecret(token);
    const api = new QuantiplyApi(token, fetch, site);

    const algos = await api.list();
    const p = planQ(
      mode,
      manifest.weekday,
      { weekday: istWeekday(), sessionOver: sessionOver() },
      wanted,
      ledger,
      algos,
    );
    lines.push(...summaryQ(p, mode));
    printed = lines.length;
    console.log(`${label}${values.apply ? '' : ' (dry run)'}\n${lines.join('\n')}`);
    if (!values.apply) return 0;

    // The ledger is what makes an algo the tool's: check it can be written before changing
    // anything (an unmounted TRADING_DATA_ROOT would otherwise leave created algos unowned).
    await mkdir(dirname(ledgerPath), { recursive: true });
    await appendFile(ledgerPath, '', 'utf8');
    const record = async (row: Omit<QLedgerRow, 'at' | 'day' | 'weekday' | 'mode'>) => {
      const full: QLedgerRow = {
        at: new Date().toISOString(),
        day: manifest.day,
        weekday: manifest.weekday,
        mode,
        ...row,
      };
      const line = `${JSON.stringify(full)}\n`;
      for (let attempt = 1; ; attempt += 1) {
        try {
          await appendFile(ledgerPath, line, 'utf8');
          return;
        } catch (error) {
          if (attempt >= 3) {
            // Stop here: anything changed after this would be unowned too. The row has no secret.
            throw new Error(
              `the ledger could not be written (${describe(error)}); add this row to ${ledgerPath} by hand: ${line.trim()}`,
            );
          }
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
    };
    /** Read an algo back and compare it with what was sent, its weekday included. */
    const check = async (body: Record<string, unknown>, id: string): Promise<string> => {
      try {
        const saved = await api.get(id);
        const diffs = readBackDiffs(body, saved);
        if (saved.day !== manifest.weekday) diffs.unshift(`day ${String(saved.day)}`);
        return diffs.length ? `READ-BACK DIFFERS: ${diffs.slice(0, 5).join(', ')}` : READ_BACK_OK;
      } catch (error) {
        return `READ-BACK FAILED: ${describe(error)}`;
      }
    };
    const owned = async (w: QWanted, id: string, verdict: string, note = '') => {
      const ok = verdict === READ_BACK_OK;
      // Created but not as sent: owned (so it can be replaced), under a sha no export will match.
      await record({
        action: 'create',
        id,
        name: w.name,
        sha: ok ? w.sha : `mismatch:${w.sha}`,
        ok: true,
        detail: `${note}${verdict}`,
      });
      if (!ok) failed = true;
      lines.push(`${ok ? '✅' : '❌'} created ${w.name} (${note}${verdict})`);
    };
    const listedBefore = new Set(algos.map((a) => a.id));

    // A replaced algo is deleted first; if that delete fails, creating it again would leave two
    // algos with one name on the day, so the create is skipped too. Keyed by algo id: a failed
    // delete of the same name on another weekday must not block this day's create.
    const notDeleted = new Set<string>();
    for (const a of p.delete) {
      try {
        await api.remove(a.id);
      } catch (error) {
        failed = true;
        notDeleted.add(a.id);
        await record({
          action: 'delete',
          id: a.id,
          name: a.name,
          sha: '',
          ok: false,
          detail: describe(error),
        });
        lines.push(`❌ delete failed: ${a.name} (${a.day}) — ${describe(error)}`);
        continue;
      }
      await record({ action: 'delete', id: a.id, name: a.name, sha: '', ok: true });
      lines.push(`deleted ${a.name} (${a.day})`);
    }
    for (const w of p.create) {
      const stuck = p.delete.some(
        (a) => a.name === w.name && a.day === manifest.weekday && notDeleted.has(a.id),
      );
      if (stuck) {
        failed = true;
        lines.push(`NOT created again, the old copy is still there: ${w.name}`);
        continue;
      }
      const body = bodies.get(w.name) ?? {};
      let saved: { id: string }[];
      try {
        saved = await api.create(body);
      } catch (error) {
        // The create may have happened on Quantiply even though this side saw an error (a
        // timeout, a dropped connection): take over a new algo of that name on the day, if any,
        // so it is not left unowned and reported as made by hand on the next run.
        let adopted: { id: string }[] = [];
        try {
          adopted = (await api.list()).filter(
            (a) => a.name === w.name && a.day === manifest.weekday && !listedBefore.has(a.id),
          );
        } catch {
          // the list failed too: reported as a failed create below
        }
        if (adopted.length) {
          for (const a of adopted) {
            await owned(w, a.id, await check(body, a.id), `adopted after "${describe(error)}": `);
          }
          failed = true; // the owner should know the API errored
          continue;
        }
        failed = true;
        await record({
          action: 'create',
          id: '',
          name: w.name,
          sha: w.sha,
          ok: false,
          detail: describe(error),
        });
        lines.push(`❌ create failed: ${w.name} — ${describe(error)}`);
        continue;
      }
      for (const s of saved) await owned(w, s.id, await check(body, s.id));
    }
    if (needsAttentionQ(p)) failed = true;
  } catch (error) {
    failed = true;
    lines.push(`❌ ${describe(error)}`);
  }

  if (values.apply) {
    const head = failed ? `⚠️ ${label}: check Quantiply` : `✅ ${label}`;
    await sendText(telegram, redact([head, ...lines].join('\n')), 'broker.quantiply').catch(
      () => undefined,
    );
  }
  console.log(lines.slice(printed).join('\n'));
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code));
