/**
 * BL-172: the 08:10 switch-on's accounts as ONE Telegram message (owner, 2026-10-28). Each
 * account's run adds its report as a JSON line `{text}` to `MORNING_REPORT_FILE`
 * (`quantiply-deploy.ts`'s `deliver`); `morning-report.ts` sends this.
 */
export function combineReports(
  fileText: string | null,
  day: string,
  expected?: number,
  title?: string,
): string;
export function combineReports(
  fileText: string | null,
  day: string,
  expected: number,
  title: string,
  quietIfEmpty: true,
): string | null;
/**
 * `quietIfEmpty` (BL-173, the evening upload): no account had anything worth saying, so nothing
 * is sent (null).
 */
export function combineReports(
  fileText: string | null,
  day: string,
  expected = 0,
  title = 'Quantiply morning switch-on',
  quietIfEmpty = false,
): string | null {
  const blocks: string[] = [];
  for (const line of (fileText ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const { text } = JSON.parse(line) as { text?: unknown };
      if (typeof text === 'string' && text.trim()) blocks.push(text.trim());
    } catch {
      // a torn line is skipped; the account's own lines are in the job log
    }
  }
  if (!blocks.length) {
    if (quietIfEmpty) return null;
    return `⚠️ ${title} ${day}: no account reported. Open the job log (quantiply-deploy) and Quantiply before 09:17.`;
  }
  // every account's run reports, also when held or crashed; one missing was killed (a timeout)
  if (blocks.length < expected) {
    blocks.push(
      `⚠️ ${expected - blocks.length} account(s) did not report (stopped?): check Quantiply before 09:17`,
    );
  }
  const warn = blocks.some((b) => b.startsWith('⚠️'));
  const head = warn ? `⚠️ ${title} ${day}: check Quantiply` : `✅ ${title} ${day}`;
  // each account's own heading loses its icon, the message's head carries it
  const body = blocks.map((b) => b.replace(/^(✅|⚠️)\s*/u, ''));
  return [head, '', body.join('\n\n')].join('\n');
}

/** The Mac's 08:02 login outcome (`<state>/broker-login/<day>.json`), as `local-login.ts` writes it. */
export interface LoginStatus {
  ok: boolean;
  nothing?: boolean;
  github?: string;
  result?: {
    algotest: { name: string; status: string }[] | null;
    quantiply: { name: string; status: string } | null;
    quantiplyShoonya: { name: string; status: string } | null;
  } | null;
}

/**
 * BL-173: the 08:10 message's first line, the morning login (whose own report is sent only on a
 * failure). Null when the Mac did not run it today, or there was nothing to log in.
 */
export function loginLine(status: LoginStatus | null): string | null {
  if (!status || status.nothing) return null;
  if (status.github) return "✅ Logged in by GitHub's backup";
  const r = status.result;
  const lines = r
    ? [
        ...(r.algotest ?? []).map((x) => ({ ...x, name: `AlgoTest · ${x.name}` })),
        r.quantiply,
        r.quantiplyShoonya,
      ].filter((x): x is { name: string; status: string } => !!x)
    : [];
  const failed = lines.filter((x) => x.status === 'FAIL').map((x) => x.name);
  if (!status.ok || failed.length) {
    return `⚠️ Login failed: ${failed.join(', ') || 'see the 08:02 login report'}`;
  }
  return `✅ Logged in: ${lines.map((x) => x.name).join(' · ') || 'nothing asked'}`;
}
