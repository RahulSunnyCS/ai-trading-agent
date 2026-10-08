// OpenNext bakes every .env it finds (including the monorepo root's) into the Worker bundle.
// Deploying that uploads every broker, Telegram and Google secret to Cloudflare. Refuse to.
import { readFileSync } from 'node:fs';

const file = new URL('../.open-next/cloudflare/next-env.mjs', import.meta.url);
const keys = [...readFileSync(file, 'utf8').matchAll(/"([A-Z][A-Z0-9_]+)"\s*:/g)].map((m) => m[1]);
if (keys.length > 0) {
  console.error(
    `Refusing to deploy: ${keys.length} env vars are bundled into the Worker (${keys.slice(0, 5).join(', ')}, …).\nMove the repo-root .env aside, rebuild, then restore it. See docs/remote-dashboard.md.`,
  );
  process.exit(1);
}
