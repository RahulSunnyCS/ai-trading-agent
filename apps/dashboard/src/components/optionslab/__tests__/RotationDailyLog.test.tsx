// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearPolledResourceCache } from '../../../hooks/usePolledResource';
import { COUNTERS, ROWS, log, placement } from '../../../lib/__tests__/rotationDailyLogFixture';
import type { RotationDay, RotationLog, RotationPlacement } from '../../../types/rotationDailyLog';
import { RotationDailyLog } from '../RotationDailyLog';
import { RotationReplayStatus } from '../RotationReplayStatus';

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };

function stubFetch(handler: Handler) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    const { status = 200, body } = handler(url, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function dayBody(day: string, saved: RotationPlacement[] = []): RotationDay {
  const r = ROWS.find((x) => x.day === day);
  if (!r) throw new Error(day);
  const current: RotationDay['placement'] = {};
  for (const p of saved) current[p.list as 'A' | 'B' | 'C' | 'REF'] = p;
  return {
    ...r,
    placement: current,
    list_info: { A: { description: 'own 5 / weekday 34', weights: {} } },
    placement_history: saved,
    journal_intact: true,
    basis: 'gross',
    entry: {
      universe: { variants: 298, sha: 'abc' },
      inputs_sha: 'x',
      inputs_days: 70,
      lots_per_strategy: 2,
      version: 3,
      prev: null,
      hash: 'f'.repeat(64),
    },
    rescore: { checked: true, same_inputs: true, same_picks: true, differs: [] },
  };
}

beforeEach(() => clearPolledResourceCache());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RotationDailyLog', () => {
  it('says when the first entry is due and lists the registered lists before there is one', async () => {
    const empty = log({
      today: '2026-10-10',
      rows: [],
      journal_entries: 0,
      chain: { entries: 0, intact: true, problems: [], head: null },
    });
    const calls = stubFetch(() => ({ body: empty }));
    render(<RotationDailyLog />);
    expect(await screen.findByText('First entry Monday 12 October, 09:16')).toBeTruthy();
    for (const key of ['A', 'B', 'C', 'REF'])
      expect(screen.getAllByText(key).length).toBeGreaterThan(0);
    expect(screen.getByText(/the live baseline/)).toBeTruthy();
    // the research history is offered, labelled, and asks for the reconstructed source
    fireEvent.click(screen.getByRole('button', { name: /Browse the reconstructed history/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('source=reconstructed'))).toBe(true),
    );
  });

  it('shows every state of a day, never a zero for a missing result, and the counters', async () => {
    stubFetch(() => ({ body: log() }));
    render(<RotationDailyLog />);
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    // header + 6 days, newest first
    expect(rows).toHaveLength(7);
    const text = (i: number) => rows[i]?.textContent ?? '';
    expect(text(1)).toMatch(/19 Oct 2026.*Waiting/); // results not stored yet
    expect(text(1)).not.toMatch(/₹0/); // no figure, not a zero
    expect(text(2)).toMatch(/16 Oct 2026.*Stop.*Scored/);
    expect(text(3)).toMatch(/15 Oct 2026.*Not recorded/);
    expect(text(3)).not.toMatch(/₹/);
    expect(text(4)).toMatch(/14 Oct 2026.*Late.*Late/); // the flag and the status
    expect(text(6)).toMatch(/12 Oct 2026.*Scored/);
    // counters line
    const counters = screen.getByLabelText('Counters');
    expect(counters.textContent).toMatch(/Recorded\s*5/);
    expect(counters.textContent).toMatch(/Buy qualified\s*A 1\/5/);
    expect(counters.textContent).toMatch(/Widesl min applied\s*A 0\/5 · B 0\/5 · C 1\/5/);
    expect(COUNTERS.days).toBe(5);
  });

  it("takes the page's focus list and then offers no second control for it", async () => {
    stubFetch(() => ({ body: log() }));
    render(<RotationDailyLog focus="REF" />);
    await screen.findByRole('table');
    expect(screen.queryByRole('radiogroup', { name: /List the calendar is shaded by/ })).toBeNull();
    expect(screen.getByText(/Shaded by list REF/)).toBeTruthy();
  });

  it('labels the filters as browsing and filters to the losing days', async () => {
    stubFetch(() => ({ body: log() }));
    render(<RotationDailyLog />);
    await screen.findByRole('table');
    expect(screen.getByText(/Filters are for browsing/)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Losing' }));
    const table = screen.getByRole('table');
    // only 16 Oct lost on list A
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    fireEvent.click(screen.getByRole('radio', { name: 'Stops' }));
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2);
  });

  it('reports a failed load with a Retry that loads again', async () => {
    let n = 0;
    stubFetch(() => {
      n += 1;
      return n === 1
        ? { status: 500, body: { error: 'the journal cannot be read: line 3' } }
        : { body: log() };
    });
    render(<RotationDailyLog />);
    expect(await screen.findByText(/the journal cannot be read/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('table')).toBeTruthy();
  });

  it('opens a day with every list in full and saves a placement as the server read it back', async () => {
    const saved: RotationPlacement[] = [];
    const calls = stubFetch((url, init) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          day: string;
          list: string;
          status: string;
          note: string;
        };
        const row = {
          ...placement(body.day, body.list as 'A', body.status as 'placed', body.note),
        };
        saved.push(row);
        return { body: { row } };
      }
      if (url.includes('/day/')) return { body: dayBody('2026-10-13', saved) };
      return { body: log() };
    });
    render(<RotationDailyLog />);
    await screen.findByRole('table');
    fireEvent.click(within(screen.getByRole('table')).getByText('13 Oct 2026'));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findAllByText('List A');
    for (const key of ['A', 'B', 'C', 'REF']) {
      expect(within(dialog).getAllByText(`List ${key}`).length).toBeGreaterThan(0);
    }
    expect(within(dialog).getAllByText(/Widesl OTM1 09:17/).length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/Executed: what you placed/i)).toBeTruthy();

    // Save is disabled until a status is chosen; "changed" needs a note
    const saveButtons = within(dialog).getAllByRole('button', { name: 'Save' });
    expect((saveButtons[0] as HTMLButtonElement).disabled).toBe(true);
    const groups = within(dialog).getAllByRole('radiogroup', { name: /Placement of list/ });
    fireEvent.click(within(groups[0] as HTMLElement).getByRole('radio', { name: 'Changed' }));
    expect(
      (within(dialog).getAllByRole('button', { name: 'Save' })[0] as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(within(dialog).getAllByLabelText(/Note for list A/)[0] as HTMLElement, {
      target: { value: 'dropped the Buy leg' },
    });
    fireEvent.click(
      within(dialog).getAllByRole('button', { name: 'Save' })[0] as HTMLButtonElement,
    );

    await waitFor(() => expect(calls.some((c) => c.init?.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.init?.method === 'POST');
    expect(post?.url).toBe('/api/backtest/legwise/rotation/placement');
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      day: '2026-10-13',
      list: 'A',
      status: 'changed',
      note: 'dropped the Buy leg',
    });
    // what is shown afterwards is the server's saved row, re-read
    expect(await within(dialog).findByText(/saved: Changed/)).toBeTruthy();
  });

  it('replays one pick from its own file: the drawer closes and Day forensics asks for the variant', async () => {
    const calls = stubFetch((url) => {
      if (url.includes('/rotation/forensics')) {
        return { status: 404, body: { error: 'no collected NIFTY data for 2026-10-13' } };
      }
      if (url.includes('/day/')) return { body: dayBody('2026-10-13') };
      return { body: log() };
    });
    render(<RotationDailyLog />);
    await screen.findByRole('table');
    fireEvent.click(within(screen.getByRole('table')).getByText('13 Oct 2026'));
    const dialog = await screen.findByRole('dialog');
    const replay = await within(dialog).findAllByRole('button', { name: /Replay N_wide_0917/ });
    fireEvent.click(replay[0] as HTMLElement);
    // the drawer is gone and the day's replay (here: its error, with the fallback note) is in the page
    expect(await screen.findByText("Couldn't replay this day")).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(/needs this day's 1-minute bars/)).toBeTruthy();
    const url = calls.find((c) => c.url.includes('/rotation/forensics'))?.url ?? '';
    expect(url).toContain('variant=N_wide_0917');
    expect(url).toContain('day=2026-10-13');
    expect(url).not.toContain('/legwise/day');
  });

  it('says a day with no entry cannot be marked', async () => {
    stubFetch((url) =>
      url.includes('/day/')
        ? { body: { ...dayBody('2026-10-15'), list_info: {}, placement_history: [] } }
        : { body: log() },
    );
    render(<RotationDailyLog />);
    await screen.findByRole('table');
    fireEvent.click(within(screen.getByRole('table')).getByText('15 Oct 2026'));
    const dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByText(/can only be marked on a day with a recorded entry/),
    ).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('labels reconstructed history as not recorded', async () => {
    stubFetch((url) => {
      if (!url.includes('source=reconstructed')) return { body: log() };
      // the API echoes the window it was asked for
      const from = new URL(url, 'http://x').searchParams.get('from');
      return {
        body: log({
          source: 'reconstructed',
          from,
          rows: ROWS.filter((r) => r.status === 'scored').map((r) => ({
            ...r,
            source: 'reconstructed' as const,
            recorded: null,
            vix: r.vix ? { ...r.vix, source: 'history' } : null,
          })),
        }),
      };
    });
    render(<RotationDailyLog />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('radio', { name: 'Reconstructed' }));
    expect(await screen.findByText(/Reconstructed, not recorded/)).toBeTruthy();
    expect(screen.getByText(/not evidence that it works/)).toBeTruthy();
  });

  it('never shows the previous source under the new label while the new one loads or fails', async () => {
    let release: (() => void) | null = null;
    let fail = false;
    const recon = log({ source: 'reconstructed', rows: [], journal_entries: 5 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('source=reconstructed')) {
          await new Promise<void>((r) => {
            release = r;
          });
          return fail
            ? new Response(JSON.stringify({ error: 'history unreadable' }), { status: 500 })
            : new Response(JSON.stringify(recon), { status: 200 });
        }
        return new Response(JSON.stringify(log()), { status: 200 });
      }),
    );
    render(<RotationDailyLog />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('radio', { name: 'Reconstructed' }));
    // the recorded rows are gone at once: a skeleton, not recorded rows under a new banner
    await waitFor(() => expect(screen.queryByRole('table')).toBeNull());
    expect(screen.getByLabelText('Loading the daily log')).toBeTruthy();
    expect(screen.queryByLabelText('Counters')).toBeNull();
    fail = true;
    await waitFor(() => expect(release).not.toBeNull());
    (release as unknown as () => void)();
    // a failure does not bring the recorded rows back under the Reconstructed banner
    expect(await screen.findByText(/history unreadable/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows a failed save in the alert role, and clears it when the field is edited', async () => {
    stubFetch((url, init) => {
      if (init?.method === 'POST') {
        return { status: 422, body: { error: 'note is 320 characters; at most 300' } };
      }
      if (url.includes('/day/')) return { body: dayBody('2026-10-13') };
      return { body: log() };
    });
    render(<RotationDailyLog />);
    await screen.findByRole('table');
    fireEvent.click(within(screen.getByRole('table')).getByText('13 Oct 2026'));
    const dialog = await screen.findByRole('dialog');
    const groups = await within(dialog).findAllByRole('radiogroup', { name: /Placement of list/ });
    fireEvent.click(within(groups[0] as HTMLElement).getByRole('radio', { name: 'Placed' }));
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Save' })[0] as HTMLElement);
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toMatch(/Not saved: note is 320 characters; at most 300/);
    expect(alert.className).toMatch(/text-negative/);
    fireEvent.change(within(dialog).getAllByLabelText(/Note for list A/)[0] as HTMLElement, {
      target: { value: 'x' },
    });
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('does not offer the same Save again when the save worked but the re-read failed', async () => {
    let posted = 0;
    let dayCalls = 0;
    stubFetch((url, init) => {
      if (init?.method === 'POST') {
        posted += 1;
        return { body: { row: placement('2026-10-13', 'A', 'placed'), written: true } };
      }
      if (url.includes('/day/')) {
        dayCalls += 1;
        return dayCalls === 1
          ? { body: dayBody('2026-10-13') }
          : { status: 500, body: { error: 'service restarting' } };
      }
      return { body: log() };
    });
    render(<RotationDailyLog />);
    await screen.findByRole('table');
    fireEvent.click(within(screen.getByRole('table')).getByText('13 Oct 2026'));
    const dialog = await screen.findByRole('dialog');
    const groups = await within(dialog).findAllByRole('radiogroup', { name: /Placement of list/ });
    fireEvent.click(within(groups[0] as HTMLElement).getByRole('radio', { name: 'Placed' }));
    const save = within(dialog).getAllByRole('button', { name: 'Save' })[0] as HTMLButtonElement;
    fireEvent.click(save);
    expect(await within(dialog).findByText(/The day could not be re-read/)).toBeTruthy();
    expect(await within(dialog).findByText(/saved: Placed/)).toBeTruthy();
    const after = within(dialog).getAllByRole('button', { name: 'Save' })[0] as HTMLButtonElement;
    expect(after.disabled).toBe(true);
    expect(after).toBe(save); // the row was not remounted: focus stays where the owner put it
    expect(posted).toBe(1);
  });

  it('keeps the earlier mark visible once it has been corrected', async () => {
    const first = placement('2026-10-13', 'A', 'placed');
    const second = {
      ...placement('2026-10-13', 'A', 'changed', 'dropped the Buy'),
      at: '2026-10-13T09:40:00+05:30',
    };
    stubFetch((url) =>
      url.includes('/day/')
        ? { body: { ...dayBody('2026-10-13', [second]), placement_history: [first, second] } }
        : { body: log() },
    );
    render(<RotationDailyLog />);
    await screen.findByRole('table');
    fireEvent.click(within(screen.getByRole('table')).getByText('13 Oct 2026'));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/History \(2 rows\)/)).toBeTruthy();
  });

  it('names each calendar day by its state and warns about unreadable placement lines', async () => {
    stubFetch(() => ({ body: log({ placement_skipped_lines: 2 }) }));
    render(<RotationDailyLog />);
    await screen.findByRole('table');
    const late = screen.getByRole('button', { name: /14 Oct 2026: late entry, not a forward day/ });
    expect(late.textContent).toMatch(/late/);
    expect(
      screen.getByText(/2 lines of rotation\/placements.jsonl are not a valid row/),
    ).toBeTruthy();
  });
});

describe('RotationReplayStatus', () => {
  afterEach(cleanup);
  it('shows a mismatch as a status with both figures, and a match quietly', () => {
    render(
      <RotationReplayStatus
        r={{
          variant: 'N_wide_0917',
          stored_gross: 1200,
          simulated_gross: 700,
          matches_stored: false,
        }}
      />,
    );
    expect(screen.getByRole('status').textContent).toMatch(/Differs from the stored result/);
    cleanup();
    render(
      <RotationReplayStatus
        r={{
          variant: 'N_wide_0917',
          stored_gross: 1200,
          simulated_gross: 1200,
          matches_stored: true,
        }}
      />,
    );
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText('Matches the stored result.')).toBeTruthy();
  });
});
