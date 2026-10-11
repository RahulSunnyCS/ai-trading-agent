// Builds the Worker with every .env file OpenNext reads hidden. OpenNext bakes `.env`, `.env.local`,
// `.env.production` and `.env.production.local`, from both the repo root and apps/dashboard, into the
// bundle, which would upload the broker, Telegram and Google secrets to Cloudflare. Each file is
// renamed beside itself (same disk, so the move is atomic and easy to find) and put back in a
// `finally` and on SIGINT/SIGTERM. A leftover from an earlier crash is restored first, or reported
// if both files exist. The files are missing for the length of the build, so do not run a scheduled
// job that reads the root `.env` meanwhile. Build-time values (MOMENTUM_DIRECT, ...) must be
// exported in the shell, not kept in a hidden file.
// OpenNext reads `.next`, which a running `next dev` for this app clears and rewrites, so the script
// refuses to start while one runs (and when NEXT_DIST_DIR points the build elsewhere).
import { spawnSync } from 'node:child_process';
import { existsSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dashboard = fileURLToPath(new URL('..', import.meta.url));
const NAMES = ['.env', '.env.local', '.env.production', '.env.production.local'];
const SUFFIX = '.cf-build-hidden';
const files = [root, dashboard].flatMap((dir) => NAMES.map((name) => `${dir}${name}`));

for (const file of files) {
  const hidden = file + SUFFIX;
  if (!existsSync(hidden)) continue;
  if (existsSync(file)) {
    console.error(`Both ${file} and ${hidden} exist. Keep the right one and delete the other.`);
    process.exit(1);
  }
  renameSync(hidden, file);
  console.error(`Restored ${file}, left hidden by an earlier interrupted build.`);
}

if (process.env.NEXT_DIST_DIR) {
  console.error(
    `NEXT_DIST_DIR=${process.env.NEXT_DIST_DIR} is set, so next build would not write .next, which OpenNext reads. Unset it and run again.`,
  );
  process.exit(1);
}
const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
const devServers = (ps.stdout ?? '')
  .split('\n')
  .filter((line) => line.includes(`${dashboard}node_modules/.bin/next dev`));
if (devServers.length > 0) {
  const pids = devServers.map((line) => line.trim().split(/\s+/)[0]).join(', ');
  console.error(`A next dev server for this app is running (pid ${pids}).`);
  console.error('It clears and rewrites .next while the build runs, and OpenNext then cannot find');
  console.error(
    'required-server-files.json. Stop it first (bun run stop:research, or kill the pid),',
  );
  console.error('build, then restart it.');
  process.exit(1);
}

const moved = [];
const restore = () => {
  while (moved.length > 0) {
    const file = moved.pop();
    if (existsSync(file + SUFFIX) && !existsSync(file)) renameSync(file + SUFFIX, file);
  }
};
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.on(signal, () => {
    restore();
    process.exit(code);
  });
}

let status = 1;
try {
  for (const file of files) {
    if (!existsSync(file)) continue;
    renameSync(file, file + SUFFIX);
    moved.push(file);
  }
  const run = (cmd, args) =>
    spawnSync(cmd, args, { cwd: dashboard, stdio: 'inherit', env: process.env }).status ?? 1;
  status = run('opennextjs-cloudflare', ['build']);
  if (status === 0) status = run('node', ['scripts/check-no-env-bundled.mjs']);
} finally {
  restore();
}
process.exit(status);
