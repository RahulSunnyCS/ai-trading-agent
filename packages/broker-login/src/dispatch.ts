/**
 * Triggers the "Daily broker login" GitHub workflow from the owner's laptop
 * (apps/scheduler, 08:00 IST trading days). GitHub's own `schedule:` trigger
 * delivers that workflow hours late; a workflow_dispatch starts within seconds. The
 * login itself still runs on GitHub with GitHub's secrets - this only starts it.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { istTimestamp, sendText } from '@trading/notify';
import { readTelegramConfig } from './config.js';
import { describe } from './diagnose.js';
import { type WorkflowRun, findRunSince, istClock, shouldDispatch } from './dispatch-rules.js';

const exec = promisify(execFile);

const WORKFLOW = 'daily-broker-login.yml';
const REF = 'main';
/** The laptop's network is often not up yet in the first seconds after a wake. */
const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 30_000;
/** Allowance for clock skew between this machine and GitHub's `createdAt`. */
const CLOCK_SKEW_MS = 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function gh(args: string[]): Promise<string> {
  const { stdout } = await exec('gh', args, { timeout: 60_000 });
  return stdout;
}

async function dispatchOnce(): Promise<WorkflowRun> {
  const since = Date.now() - CLOCK_SKEW_MS;
  await gh(['workflow', 'run', WORKFLOW, '--ref', REF]);

  // The run takes a few seconds to appear in the list after the request is accepted.
  for (let poll = 0; poll < 6; poll++) {
    await sleep(5_000);
    const listed = await gh([
      'run',
      'list',
      '--workflow',
      WORKFLOW,
      '--event',
      'workflow_dispatch',
      '--limit',
      '5',
      '--json',
      'createdAt,url',
    ]);
    const run = findRunSince(JSON.parse(listed) as WorkflowRun[], since);
    if (run) return run;
  }
  throw new Error('GitHub accepted the dispatch but no new run appeared within 30s');
}

async function main(): Promise<number> {
  console.log(`[${istTimestamp()} IST] broker login dispatch`);
  const dryRun = process.env.DRY_RUN === '1';

  if (!shouldDispatch(istClock(new Date()))) {
    console.log('outside weekday 07:45-15:35 IST (a late wake?) - not dispatching');
    if (!dryRun) return 0;
  }

  if (dryRun) {
    console.log(`dry run: gh workflow run ${WORKFLOW} --ref ${REF}`);
    console.log((await gh(['auth', 'status'])).trim());
    return 0;
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const run = await dispatchOnce();
      console.log(`dispatched: ${run.url}`);
      return 0;
    } catch (error) {
      lastError = error;
      console.warn(`attempt ${attempt}/${MAX_ATTEMPTS} failed: ${describe(error)}`);
      // A dispatch that was accepted but not yet listed must not be sent twice.
      if (error instanceof Error && error.message.startsWith('GitHub accepted')) break;
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }
  }

  const message = `🚨 Broker login was not triggered\nLaptop scheduler, ${istTimestamp()} IST\n${describe(lastError)}\nStart "Daily broker login" by hand from GitHub Actions.`;
  console.error(message);
  await sendText(readTelegramConfig(), message, 'broker.algotest').catch(() => undefined);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('dispatch crashed:', describe(error));
    process.exit(1);
  });
