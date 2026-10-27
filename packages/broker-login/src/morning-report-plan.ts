/**
 * BL-172: the 08:10 switch-on's accounts as ONE Telegram message (owner, 2026-10-28). Each
 * account's run adds its report as a JSON line `{text}` to `MORNING_REPORT_FILE`
 * (`quantiply-deploy.ts`'s `deliver`); `morning-report.ts` sends this.
 */
export function combineReports(fileText: string | null, day: string, expected = 0): string {
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
    return `⚠️ Quantiply morning switch-on ${day}: no account reported. Open the job log (quantiply-deploy) and Quantiply before 09:17.`;
  }
  // every account's run reports, also when held or crashed; one missing was killed (a timeout)
  if (blocks.length < expected) {
    blocks.push(
      `⚠️ ${expected - blocks.length} account(s) did not report (stopped?): check Quantiply before 09:17`,
    );
  }
  const warn = blocks.some((b) => b.startsWith('⚠️'));
  const head = warn
    ? `⚠️ Quantiply morning switch-on ${day}: check Quantiply`
    : `✅ Quantiply morning switch-on ${day}`;
  // each account's own heading loses its icon, the message's head carries it
  const body = blocks.map((b) => b.replace(/^(✅|⚠️)\s*/u, ''));
  return [head, '', body.join('\n\n')].join('\n');
}
