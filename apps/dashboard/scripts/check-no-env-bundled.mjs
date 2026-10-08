// OpenNext bakes every .env it finds (including the monorepo root's) into the Worker bundle.
// Deploying that uploads every broker, Telegram and Google secret to Cloudflare. Refuse to.
// The clean file is exactly three empty objects; anything else, including a format this check
// does not recognise, stops the deploy.
import { readFileSync } from 'node:fs';

const file = new URL('../.open-next/cloudflare/next-env.mjs', import.meta.url);
const clean = /^(?:export const (?:production|development|test) = \{\};\s*){3}$/;
if (!clean.test(readFileSync(file, 'utf8'))) {
  console.error(
    'Refusing to deploy: .open-next/cloudflare/next-env.mjs is not the empty env OpenNext writes\n' +
      'when no .env is found, so environment variables are probably bundled into the Worker.\n' +
      'Build with `bun run cf:build`, which keeps the repo-root .env out. See docs/remote-dashboard.md.',
  );
  process.exit(1);
}
