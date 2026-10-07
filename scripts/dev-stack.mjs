/**
 * Run the two research APIs and their shared dashboard from the repo root.
 *
 * `--prod` (BL-004) serves a production build of the dashboard (`next start`) instead of
 * `next dev`. It builds into `apps/dashboard/.next-prod`, rebuilds only when the dashboard's
 * sources, config, lockfile or baked env changed, and refuses to start without
 * DASHBOARD_PASSWORD (a production build fails closed without it: lib/accessGate.ts).
 * `--rebuild` forces the build; `--port <n>` serves the dashboard on another port.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dashboardDir = join(root, 'apps/dashboard');
const momentumDir = join(root, 'packages/momentum-backtesting');
const optionsDir = join(root, 'packages/option-backtesting');

const DEFAULT_DASHBOARD_PORT = 5190;
/** Where `--prod` builds, so a concurrent `next dev` (which owns `.next`) cannot touch it. */
const PROD_DIST_DIR = '.next-prod';
const PROD_STAMP = join(dashboardDir, PROD_DIST_DIR, 'research-stack.json');
/** The files `next` reads DASHBOARD_PASSWORD from, besides the environment. */
const PASSWORD_FILES = ['.env.local', '.env.production.local'];
// SCHEDULER_DIRECT only proxies to the scheduler launchd already keeps running; this
// stack never starts a second scheduler loop (it would run every job twice).
const DIRECT_ENV = { MOMENTUM_DIRECT: '1', OBT_DIRECT: '1', SCHEDULER_DIRECT: '1' };

/**
 * The dashboard: `next dev`, or `next start` over the `.next-prod` build. Both bind to
 * loopback only: `next dev` has no password and proxies /api/scheduler/*, so on every
 * interface anyone on the same network could start scheduler jobs.
 */
export function dashboardService({ prod = false, port = DEFAULT_DASHBOARD_PORT } = {}) {
  return {
    label: 'Dashboard',
    cwd: dashboardDir,
    ports: [...new Set([port, DEFAULT_DASHBOARD_PORT, 5180, 5173])],
    targetPort: port,
    command: 'bun',
    args: [
      'run',
      '--bun',
      'next',
      prod ? 'start' : 'dev',
      '--port',
      String(port),
      '-H',
      '127.0.0.1',
    ],
    env: prod ? { ...DIRECT_ENV, NEXT_DIST_DIR: PROD_DIST_DIR } : DIRECT_ENV,
    matches: /(?:^|[\s/])next(?:\.js)?(?:\s|\/|$)|(?:^|\s)bun\s+run\s+dev(?:\s|$)/,
  };
}

const services = {
  momentum: {
    label: 'Momentum API',
    cwd: momentumDir,
    ports: [8765, 3000], // 3000 was used by older local Momentum commands.
    targetPort: 8765,
    command: 'uv',
    args: ['run', 'mbt', 'serve'],
    matches: /(?:^|[\s/])mbt\s+(?:serve|ui)(?:\s|$)/,
  },
  options: {
    label: 'Options API',
    cwd: optionsDir,
    ports: [8000],
    targetPort: 8000,
    command: 'uv',
    args: ['run', 'obt-api'],
    matches: /(?:^|[\s/])obt-api(?:\s|$)/,
  },
  dashboard: dashboardService(),
};

export function serviceIds(mode) {
  if (mode === 'research') return ['momentum', 'options', 'dashboard'];
  if (mode === 'backends') return ['momentum', 'options'];
  if (mode === 'frontend') return ['dashboard'];
  if (mode === 'stop') return ['momentum', 'options', 'dashboard'];
  throw new Error(`Unknown mode "${mode}". Use research, backends, frontend, or stop.`);
}

export function belongsToService(info, service) {
  if (!info?.cwd || !info?.command) return false;
  return resolve(info.cwd) === resolve(service.cwd) && service.matches.test(info.command);
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') {
    throw new Error(`${command} is required but was not found on PATH.`);
  }
  return result.stdout ?? '';
}

function listeners(port) {
  return [
    ...new Set(
      capture('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'])
        .split(/\s+/)
        .map(Number)
        .filter((pid) => Number.isSafeInteger(pid) && pid > 1),
    ),
  ];
}

function processInfo(pid) {
  const cwdLine = capture('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
    .split('\n')
    .find((line) => line.startsWith('n/'));
  const cwd = cwdLine?.slice(1);
  const command = capture('ps', ['-p', String(pid), '-o', 'command=']).trim();
  const ppid = Number(capture('ps', ['-p', String(pid), '-o', 'ppid=']).trim());
  return { pid, ppid, cwd, command };
}

function ownedProcesses(service) {
  const found = new Map();
  for (const port of service.ports) {
    for (const pid of listeners(port)) {
      let info = processInfo(pid);
      if (!belongsToService(info, service)) continue;
      while (info && belongsToService(info, service) && !found.has(info.pid)) {
        found.set(info.pid, info);
        info = info.ppid > 1 ? processInfo(info.ppid) : null;
      }
    }
  }
  return [...found.values()].reverse(); // parent first, then its listening child
}

function foreignTargetListener(service) {
  return listeners(service.targetPort).find((pid) => !belongsToService(processInfo(pid), service));
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function stopService(service, dryRun, knownPids) {
  const current = () =>
    ownedProcesses(service).filter((info) => !knownPids || knownPids.has(info.pid));
  const owned = current();
  for (const info of owned) {
    console.log(
      `[${service.label}] ${dryRun ? 'would stop' : 'stopping'} PID ${info.pid}: ${info.command}`,
    );
    if (!dryRun && belongsToService(processInfo(info.pid), service)) {
      try {
        process.kill(info.pid, 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  }
  if (dryRun || owned.length === 0) return;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (current().length === 0) return;
    await pause(100);
  }
  for (const info of current()) {
    if (owned.some((item) => item.pid === info.pid) && belongsToService(info, service)) {
      console.warn(`[${service.label}] PID ${info.pid} did not stop; sending SIGKILL`);
      try {
        process.kill(info.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    if (current().length === 0) return;
    await pause(100);
  }
  throw new Error(`${service.label} did not release its port after SIGKILL.`);
}

function hasFile(dir) {
  if (!existsSync(dir)) return false;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) return true;
    if (entry.isDirectory() && hasFile(join(dir, entry.name))) return true;
  }
  return false;
}

function ensureOptionsCache() {
  if (hasFile(join(optionsDir, 'data/cache'))) return;
  if (!hasFile(join(optionsDir, 'data/raw/algotest'))) {
    console.warn(
      '[Options API] No AlgoTest raw data found; the Options Lab will need data before backtesting.',
    );
    return;
  }
  console.log('[Options API] First run: building the AlgoTest cache from data/raw…');
  const result = spawnSync('bash', ['./scripts/build-cache.sh'], {
    cwd: optionsDir,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('Options cache build failed.');
}

function pipeOutput(stream, label, destination) {
  let pending = '';
  stream.on('data', (chunk) => {
    pending += String(chunk);
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) destination.write(`[${label}] ${line}\n`);
  });
  stream.on('end', () => {
    if (pending) destination.write(`[${label}] ${pending}\n`);
  });
}

async function waitReady(service, child) {
  for (let attempt = 0; attempt < 240; attempt++) {
    if (child.exitCode !== null)
      throw new Error(`${service.label} exited before opening port ${service.targetPort}.`);
    if (listeners(service.targetPort).some((pid) => belongsToService(processInfo(pid), service)))
      return;
    await pause(500);
  }
  throw new Error(`${service.label} did not open port ${service.targetPort} within 2 minutes.`);
}

/** `KEY=value` from a dotenv file, unquoted; null when absent or blank. */
export function dotenvValue(text, key) {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*?)\\s*$`);
  let found = null;
  for (const line of text.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (!match) continue;
    const raw = match[1] ?? '';
    const quoted = /^(['"])(.*)\1$/.exec(raw);
    found = quoted ? (quoted[2] ?? '') : raw.replace(/\s+#.*$/, '');
  }
  return found?.trim() ? found : null;
}

/** Where DASHBOARD_PASSWORD comes from, or null when `next start` would serve only 503s. */
function passwordSource() {
  if (process.env.DASHBOARD_PASSWORD?.trim()) return 'the environment';
  for (const name of PASSWORD_FILES) {
    const file = join(dashboardDir, name);
    if (existsSync(file) && dotenvValue(readFileSync(file, 'utf8'), 'DASHBOARD_PASSWORD')) {
      return `apps/dashboard/${name}`;
    }
  }
  return null;
}

function requirePassword() {
  const source = passwordSource();
  if (source) return source;
  throw new Error(
    [
      'Refusing to start the production dashboard: DASHBOARD_PASSWORD is not set.',
      'A production build answers every request with 503 without it (lib/accessGate.ts).',
      'Generate one with `openssl rand -base64 24` and add it to apps/dashboard/.env.local:',
      '',
      '  DASHBOARD_PASSWORD=<the generated value>',
      '',
      'or export it in this shell. Sign in with it at /login (the browser keeps the session).',
    ].join('\n'),
  );
}

/** Everything that changes what `next build` produces, besides the environment. */
function buildInputs() {
  const dashboardFiles = [
    'next.config.ts',
    'tsconfig.json',
    'tailwind.config.ts',
    'postcss.config.js',
    'package.json',
    // NEXT_PUBLIC_* values in these are inlined into the client bundle.
    '.env',
    '.env.production',
    '.env.local',
    '.env.production.local',
  ].map((name) => join(dashboardDir, name));
  return {
    dirs: ['src', 'public'].map((name) => join(dashboardDir, name)),
    files: [
      ...dashboardFiles,
      join(root, 'bun.lock'),
      join(root, 'package.json'),
      join(root, 'tsconfig.base.json'),
    ],
  };
}

/** Newest mtime under the inputs. Directories count too: a deleted file bumps its directory. */
function newestMtime({ dirs, files }) {
  let newest = 0;
  const visit = (path) => {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return; // absent inputs (no public/, no .env.local) are simply not there
    }
    newest = Math.max(newest, stat.mtimeMs);
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(path)) visit(join(path, entry));
  };
  for (const path of [...dirs, ...files]) visit(path);
  return newest;
}

/** The env values a build bakes in: the rewrite flags and origins, and NEXT_PUBLIC_*. */
export function bakedEnv(env) {
  const keys = [
    ...Object.keys(DIRECT_ENV),
    'NEXT_DIST_DIR',
    'DASHBOARD_API_URL',
    'MOMENTUM_DIRECT_API_URL',
    'OBT_DIRECT_API_URL',
    'SCHEDULER_DIRECT_API_URL',
    ...Object.keys(env).filter((key) => key.startsWith('NEXT_PUBLIC_')),
  ];
  return Object.fromEntries(
    [...new Set(keys)].sort().flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]])),
  );
}

/** Why the build must be redone, or null when the last one still matches. */
export function rebuildReason(stamp, sourcesMtimeMs, env) {
  if (!stamp) return 'no previous build';
  if (sourcesMtimeMs > stamp.sourcesMtimeMs) return 'sources changed since the last build';
  if (JSON.stringify(stamp.env) !== JSON.stringify(env)) return 'build env changed';
  return null;
}

function readStamp() {
  if (!existsSync(join(dashboardDir, PROD_DIST_DIR, 'BUILD_ID'))) return null;
  try {
    return JSON.parse(readFileSync(PROD_STAMP, 'utf8'));
  } catch {
    return null;
  }
}

/** Builds `.next-prod` unless the last build already matches; returns quickly when it does. */
function ensureProdBuild(service, force) {
  const env = { ...process.env, ...service.env };
  const baked = bakedEnv(env);
  // Taken before building: an edit made during the build makes the next start rebuild.
  const sourcesMtimeMs = newestMtime(buildInputs());
  const reason = force ? '--rebuild' : rebuildReason(readStamp(), sourcesMtimeMs, baked);
  if (!reason) {
    console.log(`[${service.label}] production build is up to date (${PROD_DIST_DIR})`);
    return;
  }
  console.log(`[${service.label}] building for production (${reason})…`);
  // `next build` points next-env.d.ts at its distDir's types; put the tracked file back.
  const nextEnvFile = join(dashboardDir, 'next-env.d.ts');
  const nextEnv = existsSync(nextEnvFile) ? readFileSync(nextEnvFile, 'utf8') : null;
  const started = Date.now();
  const result = spawnSync('bun', ['run', '--bun', 'next', 'build'], {
    cwd: dashboardDir,
    env,
    stdio: 'inherit',
  });
  if (nextEnv !== null && readFileSync(nextEnvFile, 'utf8') !== nextEnv) {
    writeFileSync(nextEnvFile, nextEnv);
  }
  if (result.status !== 0) throw new Error('Dashboard production build failed.');
  writeFileSync(
    PROD_STAMP,
    `${JSON.stringify({ builtAt: new Date().toISOString(), sourcesMtimeMs, env: baked }, null, 2)}\n`,
  );
  console.log(`[${service.label}] built in ${Math.round((Date.now() - started) / 1000)} s`);
}

export function parseFlags(flags) {
  const portIndex = flags.indexOf('--port');
  const port = portIndex === -1 ? DEFAULT_DASHBOARD_PORT : Number(flags[portIndex + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('--port needs a port number, e.g. --port 5191.');
  }
  return {
    dryRun: flags.includes('--dry-run'),
    prod: flags.includes('--prod'),
    rebuild: flags.includes('--rebuild'),
    port,
  };
}

async function run() {
  const [mode = 'research', ...flags] = process.argv.slice(2);
  const { dryRun, prod, rebuild, port } = parseFlags(flags);
  services.dashboard = dashboardService({ prod, port });
  const selected = serviceIds(mode).map((id) => services[id]);
  const prodDashboard = prod && mode !== 'stop' && selected.includes(services.dashboard);
  if (prodDashboard) {
    console.log(`[Dashboard] DASHBOARD_PASSWORD found in ${requirePassword()}`);
  }

  if (mode !== 'stop') {
    for (const service of selected) {
      const foreignPid = foreignTargetListener(service);
      if (foreignPid) {
        throw new Error(
          `Port ${service.targetPort} is held by unrelated PID ${foreignPid}; no processes were stopped.`,
        );
      }
    }
  }

  if (!dryRun && mode !== 'stop' && selected.includes(services.options)) ensureOptionsCache();
  for (const service of selected) await stopService(service, dryRun);
  if (dryRun || mode === 'stop') return;
  if (prodDashboard) ensureProdBuild(services.dashboard, rebuild);
  const children = [];
  let stopping = false;
  const shutdown = async (code) => {
    if (stopping) return;
    stopping = true;
    for (const { service, child, pids } of children) {
      await stopService(service, false, pids);
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  try {
    for (const service of selected) {
      console.log(`[${service.label}] starting: ${service.command} ${service.args.join(' ')}`);
      const child = spawn(service.command, service.args, {
        cwd: service.cwd,
        env: { ...process.env, ...service.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const managed = { service, child, pids: new Set([child.pid]) };
      children.push(managed);
      child.on('error', (error) => {
        console.error(`[${service.label}] ${error.message}`);
        void shutdown(1);
      });
      child.on('exit', (code) => {
        if (!stopping) {
          console.log(`[${service.label}] exited with code ${code ?? 'signal'}`);
          void stopService(service, false, managed.pids);
        }
      });
      pipeOutput(child.stdout, service.label, process.stdout);
      pipeOutput(child.stderr, service.label, process.stderr);
      await waitReady(service, child);
      for (const info of ownedProcesses(service)) managed.pids.add(info.pid);
      console.log(`[${service.label}] ready on http://localhost:${service.targetPort}`);
    }
    if (selected.includes(services.dashboard)) {
      const url = `http://localhost:${services.dashboard.targetPort}`;
      const signIn = prodDashboard ? ' (sign in with DASHBOARD_PASSWORD)' : '';
      console.log(
        `\nOpen ${url}${signIn} for Momentum and Options Lab. Press Ctrl+C to stop this stack.`,
      );
    } else {
      console.log('\nBoth research APIs are ready. Press Ctrl+C to stop them.');
    }
  } catch (error) {
    console.error(error.message);
    await shutdown(1);
  }
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
