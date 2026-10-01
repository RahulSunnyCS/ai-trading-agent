/** Run the two research APIs and their shared dashboard from the repo root. */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dashboardDir = join(root, 'apps/dashboard');
const momentumDir = join(root, 'packages/momentum-backtesting');
const optionsDir = join(root, 'packages/option-backtesting');

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
  dashboard: {
    label: 'Dashboard',
    cwd: dashboardDir,
    ports: [5190, 5180, 5173],
    targetPort: 5190,
    command: 'bun',
    args: ['run', '--bun', 'next', 'dev', '--port', '5190'],
    env: { MOMENTUM_DIRECT: '1', OBT_DIRECT: '1' },
    matches: /(?:^|[\s/])next(?:\.js)?(?:\s|\/|$)|(?:^|\s)bun\s+run\s+dev(?:\s|$)/,
  },
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

async function run() {
  const [mode = 'research', ...flags] = process.argv.slice(2);
  const dryRun = flags.includes('--dry-run');
  const selected = serviceIds(mode).map((id) => services[id]);

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
      console.log(
        '\nOpen http://localhost:5190 for Momentum and Options Lab. Press Ctrl+C to stop this stack.',
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
