const registry = new Set<string>();

const inActions = process.env.GITHUB_ACTIONS === 'true';

/**
 * GitHub masks stored secrets in logs automatically, but not values derived from
 * them - a generated TOTP code would otherwise appear in plain text.
 */
export function registerSecret(value: string | undefined): void {
  if (!value || value.length < 4) return;
  if (registry.has(value)) return;
  registry.add(value);
  if (inActions) console.log(`::add-mask::${value}`);
}

export function redact(text: string): string {
  let out = text;
  // Longest first, so a secret containing another is replaced whole.
  for (const secret of [...registry].sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('***REDACTED***');
  }
  return out;
}
