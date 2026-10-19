import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sendText } from '@trading/notify';
import { chromium } from 'playwright';
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
  summaryQ,
} from './quantiply-plan.js';
import { quantiplyLogin } from './quantiply.js';
import { redact, registerSecret } from './secrets.js';
import { type Mode, istToday, sha256 } from './strategy-plan.js';

/**
 * BL-139 Phase 3: put the day's Core rotation picks into Quantiply (Angel One) as algos, through
 * Quantiply's own API (the calls its web app makes). Never enables (deploys) anything.
 *
 *   tsx src/quantiply-upload.ts --latest core | --dir <export folder> --mode evening|topup [--apply]
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
      apply: { type: 'boolean', default: false },
      headed: { type: 'boolean', default: false },
    },
  });
  if (values.mode !== 'evening' && values.mode !== 'topup') {
    console.error('usage: --dir <export folder> | --latest core, --mode evening|topup [--apply]');
    return 64;
  }
  if (existsSync('.env')) process.loadEnvFile('.env');
  if (values.apply && process.env.QUANTIPLY_UPLOAD?.trim().toLowerCase() !== 'on') {
    console.log(
      'QUANTIPLY_UPLOAD is not "on": nothing created or deleted (dry run without --apply)',
    );
    return 0;
  }
  const dataRoot = process.env.TRADING_DATA_ROOT?.trim();
  let exportDir = values.dir;
  if (!exportDir && values.latest) {
    if (!dataRoot) {
      console.error('--latest needs TRADING_DATA_ROOT');
      return 1;
    }
    exportDir = (
      await readJson<{ dir: string }>(
        join(dataRoot, 'rotation', 'quantiply', `latest-${values.latest}.json`),
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
    : join(dataRoot ?? '', 'rotation', 'quantiply', 'ledger.jsonl');
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

  const clientCode = process.env.ANGELONE_CLIENT_CODE?.trim();
  const mpin = process.env.ANGELONE_MPIN?.trim();
  const totpSecret = process.env.ANGELONE_TOTP_SECRET?.trim();
  if (!clientCode || !mpin || !totpSecret) {
    console.error('ANGELONE_CLIENT_CODE / ANGELONE_MPIN / ANGELONE_TOTP_SECRET missing from .env');
    return 1;
  }
  registerSecret(mpin);
  registerSecret(totpSecret);
  const telegram = readTelegramConfig();
  const when = mode === 'evening' ? 'evening' : '09:16 top-up';
  const label = `Quantiply CORE ${when} for ${manifest.day} (${manifest.weekday})`;
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
      await quantiplyLogin(page, { clientCode, mpin, totpSecret }, { submitted: false });
      token = await readToken(await context.newPage());
    } finally {
      await browser.close().catch(() => undefined);
    }
    registerSecret(token);
    const api = new QuantiplyApi(token);

    const algos = await api.list();
    const p = planQ(mode, manifest.weekday, istWeekday(), wanted, ledger, algos);
    lines.push(...summaryQ(p, mode));
    printed = lines.length;
    console.log(`${label}${values.apply ? '' : ' (dry run)'}\n${lines.join('\n')}`);
    if (!values.apply) return 0;

    await mkdir(dirname(ledgerPath), { recursive: true });
    const record = async (row: Omit<QLedgerRow, 'at' | 'day' | 'weekday' | 'mode'>) => {
      const full: QLedgerRow = {
        at: new Date().toISOString(),
        day: manifest.day,
        weekday: manifest.weekday,
        mode,
        ...row,
      };
      await appendFile(ledgerPath, `${JSON.stringify(full)}\n`, 'utf8');
    };

    // A replaced algo is deleted first; if that fails, creating it again would leave two algos
    // with one name on the day, so the create is skipped too.
    const notDeleted = new Set<string>();
    for (const a of p.delete) {
      try {
        await api.remove(a.id);
        await record({ action: 'delete', id: a.id, name: a.name, sha: '', ok: true });
        lines.push(`deleted ${a.name} (${a.day})`);
      } catch (error) {
        failed = true;
        notDeleted.add(a.name);
        await record({
          action: 'delete',
          id: a.id,
          name: a.name,
          sha: '',
          ok: false,
          detail: describe(error),
        });
        lines.push(`❌ delete failed: ${a.name} (${a.day}) — ${describe(error)}`);
      }
    }
    for (const w of p.create) {
      if (
        notDeleted.has(w.name) &&
        p.delete.some((a) => a.name === w.name && a.day === manifest.weekday)
      ) {
        failed = true;
        lines.push(`NOT created again, the old copy is still there: ${w.name}`);
        continue;
      }
      const body = bodies.get(w.name) ?? {};
      let saved: { id: string }[] = [];
      try {
        saved = await api.create(body);
      } catch (error) {
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
      for (const s of saved) {
        let verdict: string;
        try {
          const diffs = readBackDiffs(body, await api.get(s.id));
          verdict = diffs.length
            ? `READ-BACK DIFFERS: ${diffs.slice(0, 5).join(', ')}`
            : 'read back: identical';
        } catch (error) {
          verdict = `READ-BACK FAILED: ${describe(error)}`;
        }
        const ok = verdict === 'read back: identical';
        // Created but not as sent: owned (so it can be replaced), under a sha no export will match.
        await record({
          action: 'create',
          id: s.id,
          name: w.name,
          sha: ok ? w.sha : `mismatch:${w.sha}`,
          ok: true,
          detail: verdict,
        });
        if (!ok) failed = true;
        lines.push(`${ok ? '✅' : '❌'} created ${w.name} (${verdict})`);
      }
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
