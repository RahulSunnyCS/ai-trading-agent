const { label, notesByDay, parseArgs } = require('../run');

describe('parseArgs()', () => {
  test('defaults to the 10-session window', () => {
    expect(parseArgs([])).toEqual({
      dryRun: false,
      day: null,
      sessions: 10,
      from: null,
      to: null,
      reparse: false,
      acceptFigures: false,
    });
  });

  test('reads --dry-run, --day and --sessions', () => {
    expect(parseArgs(['--dry-run', '--day', '2026-10-23', '--sessions', '20'])).toEqual({
      dryRun: true,
      day: '2026-10-23',
      sessions: 20,
      from: null,
      to: null,
      reparse: false,
      acceptFigures: false,
    });
    expect(parseArgs(['--from', '2025-04-01', '--to', '2026-10-23']).from).toBe('2025-04-01');
    expect(() => parseArgs(['--reparse'])).toThrow(/--reparse takes/);
  });

  test('refuses what it does not know', () => {
    expect(() => parseArgs(['--sheet'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--day', '23-10-2026'])).toThrow(/YYYY-MM-DD/);
    expect(() => parseArgs(['--from', '2025-04-01'])).toThrow(/go together/);
    expect(() => parseArgs(['--from', '2026-01-01', '--to', '2025-01-01'])).toThrow(/from first/);
  });
});

describe('notesByDay()', () => {
  const acc = { broker: 'finvasia', accountId: 'FA1' };
  const msg = (uid, day, body) => ({
    uid,
    subject: `Combined Contract Note for FA1 ${day}`,
    received: 'r',
    attachments: [{ filename: 'note.pdf', content: Buffer.from(body) }],
  });

  test('groups notes by session and drops the same note mailed twice', () => {
    const { byDay } = notesByDay(
      [msg(1, '23-10-2026', 'a'), msg(2, '23-10-2026', 'a'), msg(3, '22-10-2026', 'b')],
      acc,
    );
    expect([...byDay.keys()].sort()).toEqual(['2026-10-22', '2026-10-23']);
    expect(byDay.get('2026-10-23')).toHaveLength(1);
  });

  test('keeps two different notes for one session apart, for the run to refuse', () => {
    const { byDay } = notesByDay([msg(1, '23-10-2026', 'a'), msg(2, '23-10-2026', 'b')], acc);
    expect(byDay.get('2026-10-23')).toHaveLength(2);
  });

  test("ignores another account's mail", () => {
    const other = {
      ...msg(1, '23-10-2026', 'a'),
      subject: 'Combined Contract Note for FA9 23-10-2026',
    };
    const { byDay, unread } = notesByDay([other], acc);
    expect(byDay.size).toBe(0);
    expect(unread).toHaveLength(1); // nobody in this mailbox claims it: reported
  });
});

describe('label()', () => {
  test('never prints the whole account id', () => {
    expect(label({ broker: 'angelone', accountId: 'R12345678' })).toBe('angelone R1··78');
  });
});
