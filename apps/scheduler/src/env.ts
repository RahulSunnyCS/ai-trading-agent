import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * Minimal .env parser: KEY=VALUE, optional `export `, `#` comments, single or
 * double quotes. The scheduler parses the repo .env itself and hands it to each
 * job, instead of every job sourcing it through `bash -lc` the way the plists
 * did — and Bun has no `process.loadEnvFile`, which broker-login's config uses.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key = '', rest = ''] = match;
    let value = rest.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    out[key] = value;
  }
  return out;
}

/**
 * launchd starts with a bare PATH. These are where this laptop keeps bun, uv
 * (~/.local/bin), node (fnm) and Homebrew tools such as gh and qpdf.
 */
export function jobPath(base: string | undefined): string {
  const home = homedir();
  const extra = [
    join(home, '.bun', 'bin'),
    join(home, '.local', 'bin'),
    join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  const parts = [...extra, ...(base ?? '').split(delimiter)].filter(Boolean);
  return [...new Set(parts)].join(delimiter);
}

/** The environment every job runs with: this process's env, the repo .env, a full PATH. */
export function jobEnv(repoRoot: string): Record<string, string> {
  let fromFile: Record<string, string> = {};
  try {
    fromFile = parseDotenv(readFileSync(join(repoRoot, '.env'), 'utf8'));
  } catch {
    // No .env (e.g. CI): jobs see only the process environment.
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, fromFile);
  env.PATH = jobPath(env.PATH);
  return env;
}
