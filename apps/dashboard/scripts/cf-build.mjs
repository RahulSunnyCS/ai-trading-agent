// Builds the Worker with every .env file OpenNext reads hidden. OpenNext bakes `.env`, `.env.local`,
// `.env.production` and `.env.production.local`, from both the repo root and apps/dashboard, into the
// bundle, which would upload the broker, Telegram and Google secrets to Cloudflare. Each file is
// renamed beside itself (same disk, so the move is atomic and easy to find) and put back in a
// `finally` and on SIGINT/SIGTERM. A leftover from an earlier crash is restored first, or reported
// if both files exist. The files are missing for the length of the build, so do not run a scheduled
// job that reads the root `.env` meanwhile. Build-time values (MOMENTUM_DIRECT, ...) must be
// exported in the shell, not kept in a hidden file.
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
