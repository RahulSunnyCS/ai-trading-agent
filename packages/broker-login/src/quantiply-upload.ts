import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sendText } from '@trading/notify';
import {
  describeSource,
  effectiveRow,
  readAutomation,
  uploadBooks,
} from './automation-settings.js';
import { readTelegramConfig } from './config.js';
import { describe } from './diagnose.js';
import { definitelyRefused } from './quantiply-api.js';
import { parseBrokers, parseDetail, pickBroker } from './quantiply-deploy-plan.js';
import {
  type BrokerState,
  type QLedgerRow,
  type QManifest,
  type QWanted,
  brokerBefore,
  brokerOutcome,
  istWeekday,
  needsAttentionQ,
  parseQLedger,
  planQ,
  readBackDiffs,
  sessionOver,
  summaryQ,
  weekdayOf,
  withMultiplier,
} from './quantiply-plan.js';
import { QUANTIPLY_SITES, parseQuantiplyBroker } from './quantiply-rules.js';
import {
  LoginHeld,
  LoginRefused,
  type QCredentials,
  checkLoginHold,
  openQuantiply,
  quantiplyCredentials,
  quantiplyLedgerPath,
  readJson,
} from './quantiply-session.js';
import { redact } from './secrets.js';
import { stopHeld } from './stop-hold.js';
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
 * with what was sent; a difference is recorded and alerted. Then every algo created or kept with the
 * export's content gets the account's own broker when it has none (`GET /brokers`, the one whose
 * client code is the `.env` login; the web app's "Select Client ID / Broker"), so switching it on
 * by hand needs nothing else, and is read back once more (the call rewrites the algo): one found
 * enabled is switched off, changed content is owned under a mismatch sha, a blip is retried.
 */

const READ_BACK_OK = 'read back: identical';

/**
 * Exit codes. 1: something a later attempt may fix (the network, an export not ready yet): the
 * scheduler retries. 3 (`noRetryExitCodes` in jobs.ts): a retry cannot help and would only
 * repeat it - a refused password or PIN (sending it again risks locking the account the owner
 * trades on), or a conflict, a held-back delete or a read-back that differs, which need the owner.
 */
const EXIT_RETRY = 1;
const EXIT_NO_RETRY = 3;

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
  // BL-143 Phase 4: a confirmed stop holds every upload until the owner resumes.
  const held = values.apply ? stopHeld() : null;
  if (held) {
    console.log(`Quantiply upload ${held}`);
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
  /** the account row's platform multiplier (BL-140 Phase 4); a manual --dir / --latest run is at 1 */
  let multiplier = 1;
  if (values['from-settings']) {
    const automation = readAutomation();
    decidedBy = describeSource(automation);
    multiplier = effectiveRow(automation, 'quantiply', broker).multiplier;
    const books = uploadBooks(automation, 'quantiply', broker);
    if (!books.length) {
      console.log(`${site.name}: nothing to upload (${decidedBy}); nothing changed`);
      return 0;
    }
    latest = books[0];
  }
  if (!values['from-settings']) {
    // A manual run uploads at 1; say so when the row asks for more, because the deployer applies the
    // row's multiplier and would then not recognise these algos (it enables nothing, fail closed).
    try {
      const asked = effectiveRow(readAutomation(), 'quantiply', broker).multiplier;
      if (asked !== 1) {
        console.log(
          `note: the ${site.name} row is set to multiplier ${asked}, a manual run uploads at 1: the deployer will not recognise these algos (use --from-settings)`,
        );
      }
    } catch {
      // unreadable settings are the scheduled jobs' business, not a manual upload's
    }
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
    : quantiplyLedgerPath(dataRoot ?? '', broker);
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
    const text = withMultiplier(await readFile(file, 'utf8'), multiplier);
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

  let creds: QCredentials;
  try {
    creds = quantiplyCredentials(broker);
  } catch (error) {
    console.error(describe(error));
    return 1;
  }
  const telegram = readTelegramConfig();

  // A refused login holds this account until its credentials in .env change: never send a
  // refused password or PIN again (each retry counts towards the broker's lockout).
  const stateDir = dirname(ledgerPath);
  try {
    await checkLoginHold(creds, stateDir);
  } catch (error) {
    if (!(error instanceof LoginHeld)) throw error;
    console.error(error.message);
    return EXIT_NO_RETRY;
  }
  // An account this mode already finished for the same export is not logged in again (a retry of
  // the job after the other account failed, Apply now pressed twice).
  const donePath = join(stateDir, `done-${broker}-${mode}-${manifest.day}.json`);
  const exportSha = sha256(wanted.map((w) => `${w.name}:${w.sha}`).join('\n'));
  if (values.apply && existsSync(donePath)) {
    const done = await readJson<{ sha?: string }>(donePath).catch(() => ({}) as { sha?: string });
    if (done.sha === exportSha) {
      console.log(
        `${site.name}: ${mode} for ${manifest.day} already done with this export; nothing to do`,
      );
      return 0;
    }
  }
  const when = mode === 'evening' ? 'evening' : '09:16 top-up';
  const label = `${site.name} ${manifest.book.toUpperCase()} ${when} for ${manifest.day} (${manifest.weekday})${decidedBy ? `, ${decidedBy}` : ''}${multiplier === 1 ? '' : `, multiplier ${multiplier}`}`;
  const lines: string[] = [];
  let failed = false;
  /** a failure a later attempt may fix */
  let retryable = false;
  /** the owner must look; a retry cannot help */
  let attention = false;
  let loginRefused = false;
  let printed = 0; // lines already on the console (the plan), so the end prints only the rest

  try {
    // The browser is only for the login: the token is taken and the browser closed before any call.
    let api: Awaited<ReturnType<typeof openQuantiply>>;
    try {
      api = await openQuantiply(creds, stateDir, { headed: values.headed });
    } catch (error) {
      if (error instanceof LoginRefused) loginRefused = true;
      throw error;
    }

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
    /**
     * Read an algo back and compare it with what was sent, its weekday included. `raw` is the
     * algo as read, for the broker step.
     */
    const check = async (
      body: Record<string, unknown>,
      id: string,
    ): Promise<{ verdict: string; raw?: Record<string, unknown> }> => {
      try {
        const raw = await api.get(id);
        const diffs = readBackDiffs(body, raw);
        if (raw.day !== manifest.weekday) diffs.unshift(`day ${String(raw.day)}`);
        const verdict = diffs.length
          ? `READ-BACK DIFFERS: ${diffs.slice(0, 5).join(', ')}`
          : READ_BACK_OK;
        return { verdict, raw };
      } catch (error) {
        return { verdict: `READ-BACK FAILED: ${describe(error)}` };
      }
    };
    /** Owned algos whose content is the export's, for the broker step after the creates. */
    const forBroker: { w: QWanted; id: string; raw?: Record<string, unknown> }[] = [];
    const owned = async (
      w: QWanted,
      id: string,
      read: { verdict: string; raw?: Record<string, unknown> },
      note = '',
    ) => {
      const { verdict } = read;
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
      if (!ok) {
        failed = true;
        if (verdict.startsWith('READ-BACK FAILED')) retryable = true;
        else attention = true;
      } else forBroker.push({ w, id, raw: read.raw });
      lines.push(`${ok ? '✅' : '❌'} created ${w.name} (${note}${verdict})`);
    };
    // The account's own broker (the web app's "Select Client ID / Broker"), looked up once, only
    // when an algo needs it.
    let ownBroker: Promise<{ id: string } | { error: string; retry: boolean }> | undefined;
    const brokerId = () => {
      ownBroker ??= api.brokers().then(
        (json) => {
          const pb = pickBroker(parseBrokers(json), creds.user);
          return 'error' in pb ? { ...pb, retry: false } : pb;
        },
        (error: unknown) => ({
          error: `brokers list: ${describe(error)}`,
          retry: !definitelyRefused(error),
        }),
      );
      return ownBroker;
    };
    /**
     * Give each algo the account's broker when it has none, so switching it on by hand needs
     * nothing else; read it back once after the call (the call rewrites the algo). It never
     * leaves an algo enabled: one found enabled under the call is switched off at once.
     */
    const setBrokers = async (
      items: { w: QWanted; id: string; raw?: Record<string, unknown> }[],
    ) => {
      for (const { w, id, raw: known } of items) {
        const body = bodies.get(w.name) ?? {};
        const flag = (retry: boolean) => {
          failed = true;
          if (retry) retryable = true;
          else attention = true;
        };
        let raw = known;
        if (!raw) {
          try {
            raw = await api.get(id);
          } catch (error) {
            flag(true);
            lines.push(`❌ ${w.name}: broker not checked, read back: ${describe(error)}`);
            continue;
          }
        }
        // A kept copy edited since it was made (by hand) is not the tool's to touch now.
        if (readBackDiffs(body, raw).length) {
          flag(false);
          lines.push(`❌ ${w.name}: broker not set, its content differs from the export`);
          continue;
        }
        const pb = await brokerId();
        if ('error' in pb) {
          flag(pb.retry);
          lines.push(`❌ ${w.name}: broker not set: ${pb.error}`);
          continue;
        }
        const step = brokerBefore(parseDetail(raw), pb.id);
        if (step === 'done') continue;
        if (step !== 'set') {
          flag(false);
          lines.push(`❌ ${w.name}: broker not set, ${step.skip}`);
          continue;
        }
        let callError: { text: string; refused: boolean } | undefined;
        try {
          await api.setBroker(id, pb.id);
        } catch (error) {
          callError = { text: describe(error), refused: definitelyRefused(error) };
        }
        let after: BrokerState | { failed: string };
        let diffs: string[] = [];
        try {
          const back = await api.get(id);
          after = parseDetail(back);
          diffs = readBackDiffs(body, back);
          if (back.day !== manifest.weekday) diffs.unshift(`day ${String(back.day)}`);
        } catch (error) {
          after = { failed: describe(error) };
        }
        const o = brokerOutcome({ brokerId: pb.id, callError, after, diffs });
        lines.push(`${o.ok ? '✅' : '❌'} ${w.name}: ${o.note}`);
        if (o.ok) continue;
        flag(o.retry);
        if (o.mismatch) {
          // still the tool's, under a sha no export matches: replaced, never enabled as it is
          await record({
            action: 'create',
            id,
            name: w.name,
            sha: `mismatch:${w.sha}`,
            ok: true,
            detail: o.note,
          });
        }
        if (o.switchOff) {
          let off = false;
          try {
            await api.setEnabled(id, false);
            off = !parseDetail(await api.get(id)).enabled;
          } catch (error) {
            lines.push(`  switching it off failed: ${describe(error)}`);
          }
          lines.push(
            off
              ? `  ⚠️ ${w.name} switched off again (read back disabled)`
              : `  🚨 ${w.name} may be ENABLED on the real account: switch it off in Quantiply NOW`,
          );
        }
      }
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
        retryable = true;
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
        retryable = true;
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
          attention = true;
          continue;
        }
        failed = true;
        retryable = true;
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
    const wantedBy = new Map(wanted.map((w) => [w.name, w]));
    for (const a of p.kept) {
      const w = wantedBy.get(a.name);
      if (w) forBroker.push({ w, id: a.id });
    }
    await setBrokers(forBroker);
    if (needsAttentionQ(p)) {
      failed = true;
      attention = true;
    }
    if (!failed) {
      await writeFile(
        donePath,
        `${JSON.stringify({ sha: exportSha, at: new Date().toISOString() })}\n`,
      ).catch(() => undefined);
    }
  } catch (error) {
    failed = true;
    if (!loginRefused) retryable = true;
    lines.push(
      loginRefused
        ? `❌ login refused - NOT retried; held until ${creds.names[1]} in .env changes: ${describe(error)}`
        : `❌ ${describe(error)}`,
    );
  }

  if (values.apply) {
    const head = failed ? `⚠️ ${label}: check Quantiply` : `✅ ${label}`;
    await sendText(telegram, redact([head, ...lines].join('\n')), 'broker.quantiply').catch(
      () => undefined,
    );
  }
  console.log(lines.slice(printed).join('\n'));
  if (loginRefused) return EXIT_NO_RETRY;
  if (retryable) return EXIT_RETRY;
  return attention || failed ? EXIT_NO_RETRY : 0;
}

main().then((code) => process.exit(code));
