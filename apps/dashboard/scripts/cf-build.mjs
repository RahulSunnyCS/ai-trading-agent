// Builds the Worker with the repo-root .env hidden. OpenNext bakes every .env it finds into the
// bundle, which would upload the broker, Telegram and Google secrets to Cloudflare. The file is
// renamed beside itself (same disk, so the move is atomic and easy to find) and put back in a
// `finally` and on SIGINT/SIGTERM. A leftover from an earlier crash is restored first, or
// reported if both files exist.
import { spawnSync } from 'node:child_process';
import { existsSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dashboard = fileURLToPath(new URL('..', import.meta.url));
const envFile = `${root}.env`;
const hidden = `${root}.env.cf-build-hidden`;

if (existsSync(hidden)) {
  if (existsSync(envFile)) {
    console.error(`Both ${envFile} and ${hidden} exist. Keep the right one and delete the other.`);
    process.exit(1);
  }
  renameSync(hidden, envFile);
  console.error('Restored a .env left hidden by an earlier interrupted build.');
}

let moved = false;
const restore = () => {
  if (moved && existsSync(hidden) && !existsSync(envFile)) renameSync(hidden, envFile);
  moved = false;
};
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    restore();
    process.exit(130);
  });
}

let status = 1;
try {
  if (existsSync(envFile)) {
    renameSync(envFile, hidden);
    moved = true;
  }
  const run = (cmd, args) =>
    spawnSync(cmd, args, { cwd: dashboard, stdio: 'inherit', env: process.env }).status ?? 1;
  status = run('opennextjs-cloudflare', ['build']);
  if (status === 0) status = run('node', ['scripts/check-no-env-bundled.mjs']);
} finally {
  restore();
}
process.exit(status);
