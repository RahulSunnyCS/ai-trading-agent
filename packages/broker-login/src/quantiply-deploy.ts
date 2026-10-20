import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isTradingDay } from '@trading/market-reference';
import { sendText } from '@trading/notify';
import {
  type Automation,
  type Book,
  describeSource,
  quantiplyDeploy,
  readAutomation,
} from './automation-settings.js';
import { readTelegramConfig } from './config.js';
import { describe } from './diagnose.js';
import type { QuantiplyApi } from './quantiply-api.js';
import {
  type AlgoDetail,
  type DeployMode,
  ENABLE_LEAD_SECONDS,
  defaultSession,
  enabledSessions,
  istSeconds,
  ownedForSession,
  parseBrokers,
  parseDeployLedger,
  parseDetail,
  pickBroker,
  planDisable,
  planEnable,
  staleEnabled,
  startSeconds,
  summaryDisable,
  summaryEnable,
  toggledIds,
  verifyToggles,
} from './quantiply-deploy-plan.js';
import {
  type QManifest,
  ownedIds,
  parseQLedger,
  readBackDiffs,
  weekdayOf,
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
import { istToday, sha256 } from './strategy-plan.js';

/**
 * BL-139 Phase 4: enable (deploy) or disable the uploader's Quantiply algos, through Quantiply's
 * own API (`PUT /algos/:id/enable|disable`, the web app's row switch; docs/algotest-execution.md,
 * "Quantiply algos through its API"). An enabled algo trades the owner's REAL account on its
 * weekday, every week, until disabled. Built ready but OFF.
 *
 *   tsx src/quantiply-deploy.ts --broker angelone|finvasia --mode enable|disable|check
 *     [--day YYYY-MM-DD] [--book core|t1 | --dir <export folder>] [--emergency] [--apply]
 *
 * - Only algos in that account's uploader ledger (`rotation/quantiply/ledger[-<broker>].jsonl`)
 *   for the session (`--day`) are touched; never one the owner made (pure rules in
 *   `quantiply-deploy-plan.ts`).
 * - `--day` defaults, for enable, to today before 15:30 IST on a trading day, else the next
 *   trading day; for disable and check, to today. The run prints which and why.
 * - enable: the session's picks (the export's manifest, `latest-<book>.json`; the book from
 *   Settings › Automation unless `--book`) that the uploader created, each read back against its
 *   export and set to the account's broker if unset, are enabled; never one this session's deploy
 *   ledger shows switched on or off already (the owner may have switched it off). For today, never
 *   within 90 s of an algo's start (TOO LATE, that algo only, checked again just before the
 *   call). An owned algo of the session that is ENABLED but no longer a pick, or fails a check, is
 *   switched off if it has not started, else reported as ENABLED.
 * - disable: the session's owned algos still enabled (and any of an earlier session) are
 *   disabled, so they do not run again next week. Only finished ones, and today's only after
 *   15:30 IST unless `--emergency` (the emergency stop: today's pending entries too).
 * - check: read-only: owned algos enabled after their session.
 * - After any change the list is read again: exactly the intended algos must have changed, and no
 *   other algo of the tool's; anything else stops the run, alerts and exits 3.
 *
 * Gates: without `--apply` it logs in, prints the plan and changes nothing. Enabling with
 * `--apply` needs `QUANTIPLY_DEPLOY=on` (else it stops before logging in), the dashboard's
 * "Automated deployment" switch and the account's row uploading a list. Disabling is the safety
 * net and is never gated: `--mode disable --apply` always runs, whatever `QUANTIPLY_DEPLOY` and the
 * switch say, because switching off only ever lowers what trades. Every change is a row in
 * `deploy-ledger[-<broker>].jsonl`. The JWT is never logged.
 */

/** 1: may succeed on a retry, nothing was changed blind. 3: the owner must look; never retried. */
const EXIT_RETRY = 1;
const EXIT_NO_RETRY = 3;

/** Already in the report's lines; ends the run without another line. */
class Reported extends Error {}

interface Picks {
  manifest: QManifest;
  sha: Map<string, string>;
  body: Map<string, Record<string, unknown>>;
}

async function readPicks(dir: string): Promise<Picks> {
  const manifest = await readJson<QManifest>(join(dir, 'manifest.json'));
  const sha = new Map<string, string>();
  const body = new Map<string, Record<string, unknown>>();
  for (const s of manifest.strategies) {
    const text = await readFile(join(dir, s.file), 'utf8');
    sha.set(s.name, sha256(text));
    body.set(s.name, JSON.parse(text) as Record<string, unknown>);
  }
  return { manifest, sha, body };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      broker: { type: 'string' },
      mode: { type: 'string' },
      day: { type: 'string' },
      book: { type: 'string' },
      dir: { type: 'string' },
      ledger: { type: 'string' },
      emergency: { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
      headed: { type: 'boolean', default: false },
    },
  });
  const mode = values.mode as DeployMode;
  if (!['enable', 'disable', 'check'].includes(mode ?? '')) {
    console.error(
      'usage: --broker angelone|finvasia --mode enable|disable|check [--day YYYY-MM-DD] [--book core|t1 | --dir <folder>] [--emergency] [--apply]',
    );
    return 64;
  }
  if (mode === 'check' && values.apply) {
    console.error('check is read-only: no --apply');
    return 64;
  }
  if (values.emergency && mode !== 'disable') {
    console.error('--emergency is for --mode disable only');
    return 64;
  }
  if (values.day && !/^\d{4}-\d\d-\d\d$/.test(values.day)) {
    console.error(`--day ${values.day} is not YYYY-MM-DD`);
    return 64;
  }
  if (existsSync('.env')) process.loadEnvFile('.env');
  const broker = parseQuantiplyBroker(values.broker);
  const site = QUANTIPLY_SITES[broker];

  // Gate 1, before any login, for enable only: the .env switch. Disable is never gated.
  if (
    values.apply &&
    mode === 'enable' &&
    process.env.QUANTIPLY_DEPLOY?.trim().toLowerCase() !== 'on'
  ) {
    console.log(`${site.name}: QUANTIPLY_DEPLOY is not "on": nothing enabled`);
    return 0;
  }
  // The disable safety net reads nothing it does not use: no automation settings.
  let gate: ReturnType<typeof quantiplyDeploy> = { ok: false, book: null, why: '' };
  let decidedBy = 'settings not read (disable never needs them)';
  if (mode !== 'disable') {
    let automation: Automation;
    try {
      automation = readAutomation();
    } catch (error) {
      console.error(`automation settings: ${describe(error)}`);
      return EXIT_RETRY;
    }
    gate = quantiplyDeploy(automation, broker);
    decidedBy = describeSource(automation);
  }
  // Gate 2: enabling also needs the dashboard's switch and the account's row.
  if (values.apply && mode === 'enable' && !gate.ok) {
    console.log(`${site.name}: ${gate.why} (${decidedBy}): nothing enabled`);
    return 0;
  }
  const apply = values.apply;

  const dataRoot = process.env.TRADING_DATA_ROOT?.trim();
  if (!values.ledger && !dataRoot) {
    console.error('the ledger lives under TRADING_DATA_ROOT: set it, or pass --ledger');
    return EXIT_RETRY;
  }
  const ledgerPath = values.ledger
    ? resolve(values.ledger)
    : quantiplyLedgerPath(dataRoot ?? '', broker);
  const stateDir = dirname(ledgerPath);
  const deployLedger = join(
    stateDir,
    broker === 'angelone' ? 'deploy-ledger.jsonl' : `deploy-ledger-${broker}.jsonl`,
  );
  const ledger = existsSync(ledgerPath) ? parseQLedger(await readFile(ledgerPath, 'utf8')) : [];
  // Unreadable is empty, with a warning: the deploy ledger must never stop a disable. (For an
  // enable it only ever holds back: an id it lists is never switched on again.)
  let deployRows: ReturnType<typeof parseDeployLedger> = [];
  try {
    if (existsSync(deployLedger))
      deployRows = parseDeployLedger(await readFile(deployLedger, 'utf8'));
  } catch (error) {
    console.error(`the deploy ledger could not be read, taken as empty: ${describe(error)}`);
    if (mode === 'enable') {
      console.error('enable needs it (an algo switched off since must stay off): nothing enabled');
      return EXIT_RETRY;
    }
  }
  const enabledFor = enabledSessions(deployRows);

  const today = istToday();
  const chosen = values.day
    ? { day: values.day, why: '--day' }
    : defaultSession(mode, today, istSeconds(), isTradingDay);
  const session = chosen.day;
  const weekday = weekdayOf(session);
  const label = `${site.name} ${mode}${values.emergency ? ' (EMERGENCY)' : ''} for ${session} (${weekday})`;
  console.log(`${label}: session from ${chosen.why}; ${decidedBy}`);

  let picks: Picks | null = null;
  if (mode === 'enable') {
    let dir = values.dir;
    const book = (values.book ?? gate.book) as Book | null;
    if (!dir) {
      if (!book) {
        console.error(
          `no list for ${site.name} in the settings (${decidedBy}); pass --book or --dir`,
        );
        return EXIT_NO_RETRY;
      }
      const pointer = join(
        dataRoot ? join(dataRoot, 'rotation', 'quantiply') : stateDir,
        `latest-${book}.json`,
      );
      dir = (await readJson<{ dir: string }>(pointer).catch(() => ({ dir: '' }))).dir;
      if (!dir) {
        console.error(`no export: ${pointer}`);
        return EXIT_RETRY;
      }
    }
    picks = await readPicks(resolve(dir));
    const m = picks.manifest;
    // The picks must be the session's: the evening's preview, or today's recorded picks.
    const fits =
      m.day === session &&
      weekdayOf(m.day) === m.weekday &&
      (session > today || m.source === 'recorded');
    if (!fits) {
      console.error(
        `the export is ${m.source} for ${m.day} (${m.weekday}); the session is ${session}${session === today ? " and needs today's recorded picks" : ''}: nothing enabled`,
      );
      return EXIT_RETRY;
    }
    console.log(`picks (${m.book}, ${m.source}): ${[...picks.sha.keys()].join(', ')}`);
  }

  // Nothing of the tool's to look at: no login (every login is an Angel One / Shoonya TOTP).
  const owned = ownedIds(ledger);
  const relevant =
    mode === 'enable'
      ? ownedForSession(ledger, session, picks?.sha).size
      : mode === 'disable'
        ? [...owned.entries()].filter(([id, r]) => {
            const later = enabledFor.get(id) ?? '';
            const at = later > r.day ? later : r.day;
            return at === session || at < today;
          }).length
        : owned.size;
  if (!relevant) {
    console.log(
      `nothing the uploader created for ${session} on this account: no login, nothing to do`,
    );
    return 0;
  }

  let creds: QCredentials;
  try {
    creds = quantiplyCredentials(broker);
  } catch (error) {
    console.error(describe(error));
    return EXIT_RETRY;
  }
  try {
    await checkLoginHold(creds, stateDir);
  } catch (error) {
    if (!(error instanceof LoginHeld)) throw error;
    console.error(error.message);
    return EXIT_NO_RETRY;
  }

  const lines: string[] = [];
  let printed = 0;
  let retryable = false;
  let attention = false;
  let changed = false;
  const record = async (row: Record<string, unknown>) => {
    const line = `${JSON.stringify({ at: new Date().toISOString(), session, mode, ...row })}\n`;
    try {
      await appendFile(deployLedger, line, 'utf8');
    } catch (error) {
      // The change is made; say what to add rather than stop half way through a verify.
      attention = true;
      lines.push(`❌ the deploy ledger could not be written (${describe(error)}): ${line.trim()}`);
    }
  };
  const ownedSet = new Set(owned.keys());
  /** Re-read the list; true when exactly the intended changes show. */
  const verify = async (
    before: Awaited<ReturnType<QuantiplyApi['list']>>,
    after: Awaited<ReturnType<QuantiplyApi['list']>>,
    intended: Map<string, boolean>,
    uncertain: Set<string>,
  ): Promise<boolean> => {
    const v = verifyToggles(before, after, intended, uncertain, ownedSet);
    for (const n of v.notes) lines.push(`note (not the tool's): ${n}`);
    if (v.problems.length) {
      attention = true;
      lines.push(`❌ VERIFY: ${v.problems.join('; ')}`);
      return false;
    }
    return true;
  };

  try {
    let api: QuantiplyApi;
    try {
      // A refused TOTP code changes nothing on Quantiply: one more login in the next window.
      api = await openQuantiply(creds, stateDir, { headed: values.headed, retryTotpOnce: true });
    } catch (error) {
      if (error instanceof LoginRefused) {
        attention = true;
        lines.push(
          `❌ login refused - NOT retried; held until ${creds.names[1]} in .env changes: ${describe(error)}`,
        );
        throw new Reported('login refused');
      }
      throw error;
    }
    const before = await api.list();

    if (mode === 'check') {
      const stale = staleEnabled(today, istSeconds(), ledger, before, enabledFor);
      const mine = ownedForSession(ledger, session);
      const states = before
        .filter((a) => mine.has(a.id))
        .map((a) => `${a.name} ${a.enabled ? 'ENABLED' : 'disabled'} (${a.status})`);
      lines.push(states.length ? `${session}: ${states.join(', ')}` : `${session}: none listed`);
      if (stale.length) {
        attention = true;
        lines.push(`⚠️ ENABLED after its session, would run again next week: ${stale.join(', ')}`);
      } else lines.push('no owned algo is enabled after its session');
    } else if (mode === 'disable') {
      const plan = planDisable(session, today, ledger, before, {
        nowSeconds: istSeconds(),
        emergency: values.emergency,
        enabledFor,
      });
      const s = summaryDisable(plan);
      lines.push(...s.lines);
      if (s.attention) attention = true;
      printed = lines.length;
      console.log(`${label}${apply ? '' : ' (dry run)'}\n${lines.join('\n')}`);
      if (apply && plan.disable.length) {
        await mkdir(stateDir, { recursive: true });
        const intended = new Map<string, boolean>();
        const failedIds = new Set<string>();
        for (const t of plan.disable) {
          try {
            await api.setEnabled(t.id, false);
            changed = true;
            intended.set(t.id, false);
            await record({ action: 'disable', id: t.id, name: t.name, ok: true });
          } catch (error) {
            failedIds.add(t.id);
            await record({
              action: 'disable',
              id: t.id,
              name: t.name,
              ok: false,
              detail: describe(error),
            });
            lines.push(`❌ disable failed: ${t.name} — ${describe(error)}`);
          }
        }
        const after = await api.list();
        // A failed disable is safe to retry: still enabled -> retried; disabled after all -> done.
        for (const id of failedIds) {
          const a = after.find((x) => x.id === id);
          if (a && !a.enabled) intended.set(id, false);
          else retryable = true;
        }
        if ((await verify(before, after, intended, new Set())) && intended.size) {
          lines.push(
            `✅ disabled and confirmed: ${plan.disable
              .filter((t) => intended.has(t.id))
              .map((t) => t.name)
              .join(', ')}`,
          );
        }
      }
    } else {
      const p = picks as Picks;
      const pb = pickBroker(parseBrokers(await api.brokers()), creds.user);
      const mine = ownedForSession(ledger, session, p.sha);
      const details = new Map<string, AlgoDetail>();
      for (const a of before) {
        if (!mine.has(a.id)) continue;
        try {
          const raw = await api.get(a.id);
          const body = p.body.get(a.name);
          details.set(a.id, { ...parseDetail(raw), diffs: body ? readBackDiffs(body, raw) : null });
        } catch (error) {
          lines.push(`could not read ${a.name}: ${describe(error)}`);
        }
      }
      const plan = planEnable({
        session,
        today,
        nowSeconds: istSeconds(),
        picks: p.sha,
        ledger,
        algos: before,
        details,
        brokerId: 'id' in pb ? pb.id : '',
        toggled: toggledIds(deployRows, session),
      });
      if ('error' in pb) plan.refused = `the account's broker: ${pb.error}`;
      const s = summaryEnable(plan);
      lines.push(...s.lines);
      if (s.attention) attention = true;
      printed = lines.length;
      console.log(`${label}${apply ? '' : ' (dry run)'}\n${lines.join('\n')}`);

      if (apply && !plan.refused && (plan.enable.length || plan.disable.length)) {
        await mkdir(stateDir, { recursive: true });
        await appendFile(deployLedger, '', 'utf8');
        const brokerId = 'id' in pb ? pb.id : '';
        const intended = new Map<string, boolean>();
        const uncertain = new Set<string>();
        let stop = false;
        // Switching off first: it only ever lowers what trades.
        for (const t of plan.disable) {
          try {
            await api.setEnabled(t.id, false);
            changed = true;
            intended.set(t.id, false);
            await record({ action: 'disable', id: t.id, name: t.name, ok: true, detail: t.why });
          } catch (error) {
            uncertain.add(t.id);
            await record({
              action: 'disable',
              id: t.id,
              name: t.name,
              ok: false,
              detail: describe(error),
            });
            lines.push(`❌ disable failed: ${t.name} — ${describe(error)}`);
            stop = true;
            break;
          }
        }
        for (const t of stop ? [] : plan.enable) {
          const body = p.body.get(t.name) ?? {};
          try {
            if (t.setBroker) {
              await api.setBroker(t.id, brokerId);
              changed = true;
              // The broker call rewrites the algo: read it back in full before enabling it.
              const raw = await api.get(t.id);
              const back = parseDetail(raw);
              const diffs = readBackDiffs(body, raw);
              const ok = back.broker === brokerId && !back.enabled && !diffs.length;
              await record({ action: 'broker', id: t.id, name: t.name, ok });
              if (!ok) {
                throw new Error(
                  `after setting the broker it reads broker ${back.broker === brokerId ? 'set' : back.broker ? 'another account' : 'unset'}, ${back.enabled ? 'ENABLED' : 'disabled'}${diffs.length ? `, content differs: ${diffs.slice(0, 3).join(', ')}` : ''}`,
                );
              }
            }
          } catch (error) {
            attention = true;
            lines.push(`❌ ${t.name}: broker not set, not enabled — ${describe(error)}`);
            break;
          }
          // The plan checked the time at login and the broker call took a while: check again
          // right before the call that deploys it.
          if (session === today && t.startTime) {
            const left = startSeconds(t.startTime) - istSeconds();
            if (left < ENABLE_LEAD_SECONDS) {
              attention = true;
              lines.push(
                `TOO LATE, not enabled: ${t.name} (${left} s to its ${t.startTime} start)`,
              );
              continue;
            }
          }
          try {
            await api.setEnabled(t.id, true);
            changed = true;
            intended.set(t.id, true);
            await record({ action: 'enable', id: t.id, name: t.name, ok: true });
          } catch (error) {
            uncertain.add(t.id);
            await record({
              action: 'enable',
              id: t.id,
              name: t.name,
              ok: false,
              detail: describe(error),
            });
            lines.push(`❌ enable failed: ${t.name} — ${describe(error)}`);
            break; // never carry on blind
          }
        }
        const after = await api.list();
        if (await verify(before, after, intended, uncertain)) {
          const on = plan.enable.filter((t) => intended.get(t.id) === true).map((t) => t.name);
          const off = plan.disable.filter((t) => intended.get(t.id) === false).map((t) => t.name);
          if (on.length) lines.push(`✅ enabled and confirmed: ${on.join(', ')}`);
          if (off.length) lines.push(`✅ disabled and confirmed: ${off.join(', ')}`);
        }
      }
    }
  } catch (error) {
    if (!(error instanceof Reported)) {
      // nothing was changed yet: a later attempt may work; after a change, the owner must look
      if (changed) attention = true;
      else retryable = true;
      lines.push(`❌ ${describe(error)}`);
    }
  }

  const failed = retryable || attention;
  // Quiet when nothing happened: the scheduler alerts on a failure, a change always reports.
  // A dry run never messages, except a failed check (it exists to alert).
  const send = (apply && (changed || failed)) || (mode === 'check' && failed);
  if (send) {
    const head = failed ? `⚠️ ${label}: check Quantiply` : `✅ ${label}`;
    await sendText(
      readTelegramConfig(),
      redact([head, ...lines].join('\n')),
      'broker.quantiply',
    ).catch(() => undefined);
  }
  console.log(lines.slice(printed).join('\n'));
  // Disable: a retry may still switch off what is left on, so a retryable failure wins (the
  // 15:40 job's retries run). Enable is never retried: the owner must look first.
  if (mode === 'disable' && retryable) return EXIT_RETRY;
  if (attention) return EXIT_NO_RETRY;
  if (retryable) return EXIT_RETRY;
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch(async (error: unknown) => {
    // Anything unexpected (a bad export or manifest, a bad --broker): say so, never silently.
    const text = `⚠️ Quantiply deploy (${process.argv.slice(2).join(' ')}) stopped: ${describe(error)}`;
    console.error(text);
    if (process.argv.includes('--apply')) {
      await Promise.resolve()
        .then(() => sendText(readTelegramConfig(), redact(text), 'broker.quantiply'))
        .catch(() => undefined);
    }
    process.exit(EXIT_RETRY);
  });
