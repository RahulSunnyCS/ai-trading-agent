'use client';

import { useEffect, useMemo, useState } from 'react';

import { usePolledResource } from '../../hooks/usePolledResource';
import { apiPost, apiPut } from '../../lib/api';
import {
  type AutomationSettings,
  type AutomationView,
  LIST_LABEL,
  type List,
  MASTER_LABEL,
  ROWS,
  describeChanges,
  githubOutcome,
  heldByMaster,
  withMaster,
  withRow,
} from '../../lib/automation';
import { formatIstDateTime } from '../../lib/format';
import { SCHEDULER_API, runNowError } from '../../lib/scheduler';
import { Accordion } from '../ui/Accordion';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { RefreshButton } from '../ui/RefreshButton';
import { SegmentedControl } from '../ui/SegmentedControl';
import { SkeletonRows } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';
import { toast } from '../ui/Toast';
import { SettingSwitch } from './SettingSwitch';

const URL = `${SCHEDULER_API}/settings/automation`;

const MASTER_HELP = {
  logins: 'The 08:00 broker logins and the 08:15 GitHub backstop. Off: no automated login at all.',
  uploads: "The evening and 09:16 top-up uploads of each list's picks.",
  deploy:
    'Deploying the uploaded strategies. The deploy jobs also stay off until their .env switch is on.',
} as const;

const LIST_OPTIONS = (['none', 'core', 't1'] as const).map((value) => ({
  value,
  label: LIST_LABEL[value],
}));

/**
 * What the daily automation does (BL-140): three master switches and, per platform + broker, the
 * 08:00 login, the list it gets and whether that list is uploaded. Edits are a draft until Save,
 * which stores a new version in the scheduler and updates the GitHub variables its 08:15
 * backstop reads. The .env switches (ALGOTEST_UPLOAD, QUANTIPLY_UPLOAD, ALGOTEST_DEPLOY) still
 * have the last word.
 */
export function AutomationSettingsCard() {
  const { data, loading, error, refetch } = usePolledResource<AutomationView>(URL);
  const [view, setView] = useState<AutomationView | null>(null);
  const [draft, setDraft] = useState<AutomationSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setView(data);
    setDraft(data.current.settings);
  }, [data]);

  const saved = view?.current.settings ?? null;
  const changes = useMemo(
    () => (saved && draft ? describeChanges(saved, draft) : []),
    [saved, draft],
  );

  async function save() {
    if (!draft || saving || changes.length === 0) return;
    setSaving(true);
    const result = await apiPut<AutomationView>(URL, draft);
    setSaving(false);
    if (!result.ok) {
      toast(`Not saved: ${result.error}. Your changes are still here.`, 'error');
      return;
    }
    setView(result.data);
    setDraft(result.data.current.settings);
    const sync = githubOutcome(result.data.current.github);
    toast(
      `Saved as version ${result.data.current.version}.${sync ? ` ${sync.text}.` : ''}`,
      sync?.failed ? 'error' : 'success',
    );
  }

  /** Run a platform's evening upload now, so a saved change reaches tomorrow's picks today. */
  async function applyNow(job: string, platform: string) {
    if (applying) return;
    setApplying(job);
    const result = await apiPost<{ runId: number | null }>(`${SCHEDULER_API}/jobs/${job}/run`, {});
    setApplying(null);
    if (!result.ok) {
      toast(runNowError(result.status, result.error), 'error');
      return;
    }
    toast(
      `${platform}: tomorrow's upload started. Its result comes on Telegram and in Jobs.`,
      'success',
    );
  }

  const outcome = githubOutcome(view?.current.github ?? null);

  return (
    <Card>
      <CardHeader
        title="Automation"
        description="What the daily jobs do on AlgoTest and Quantiply. Changes apply from each job's next run."
        actions={<RefreshButton onClick={refetch} loading={loading} />}
      />
      {!view || !draft ? (
        loading ? (
          <SkeletonRows rows={6} />
        ) : (
          <StateMessage
            variant="error"
            title="Scheduler not reachable"
            description={`Automation settings live in the scheduler (${error ?? 'no response'}). Start the dev stack with "bun run start" (it sets SCHEDULER_DIRECT=1).`}
          />
        )
      ) : (
        <div className="space-y-6">
          <section className="space-y-4" aria-label="Master switches">
            {(['logins', 'uploads', 'deploy'] as const).map((key) => (
              <SettingSwitch
                key={key}
                label={MASTER_LABEL[key]}
                description={MASTER_HELP[key]}
                checked={draft.masters[key]}
                disabled={saving}
                onChange={(on) => setDraft(withMaster(draft, key, on))}
              />
            ))}
          </section>

          <section className="space-y-3" aria-label="Platforms and brokers">
            {ROWS.map(({ key, platform, broker }) => {
              const row = draft.rows[key];
              const held = heldByMaster(draft, key);
              return (
                <div key={key} className="rounded-lg border border-border p-3">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">
                      {platform} · {broker}
                    </span>
                    {held ? <Badge tone="warning">{held}</Badge> : null}
                  </div>
                  <div className="space-y-3">
                    <SettingSwitch
                      label="Log in at 08:00"
                      checked={row.login}
                      disabled={saving}
                      onChange={(login) => setDraft(withRow(draft, key, { login }))}
                    />
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <span className="text-sm font-medium text-foreground">List</span>
                      <SegmentedControl<List>
                        ariaLabel={`${platform} · ${broker} list`}
                        size="sm"
                        value={row.list}
                        options={LIST_OPTIONS}
                        onChange={(list) => setDraft(withRow(draft, key, { list }))}
                      />
                    </div>
                    <SettingSwitch
                      label="Upload the list's picks"
                      description={row.list === 'none' ? 'Choose a list first.' : undefined}
                      checked={row.upload}
                      disabled={saving || row.list === 'none'}
                      onChange={(upload) => setDraft(withRow(draft, key, { upload }))}
                    />
                  </div>
                </div>
              );
            })}
          </section>

          <section className="space-y-3 border-t border-border pt-4" aria-label="Save">
            {changes.length ? (
              <div>
                <p className="text-sm font-medium text-foreground">
                  {changes.length} unsaved {changes.length === 1 ? 'change' : 'changes'}
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted">
                  {changes.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-muted">
                  The evening upload runs at 16:40 (AlgoTest) and 16:45 (Quantiply). A change saved
                  after that reaches tomorrow only through the next run.
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted">
                {view.current.version
                  ? `Version ${view.current.version}, saved ${formatIstDateTime(view.current.saved_at)}.`
                  : 'Not saved yet: these are the starting settings (today’s setup).'}{' '}
                {outcome ? (
                  <span className={outcome.failed ? 'text-negative' : undefined}>
                    {outcome.text}.
                  </span>
                ) : null}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                onClick={() => void save()}
                loading={saving}
                disabled={changes.length === 0}
              >
                Save
              </Button>
              <Button
                variant="ghost"
                onClick={() => setDraft(view.current.settings)}
                disabled={saving || changes.length === 0}
              >
                Discard changes
              </Button>
            </div>
          </section>

          <section className="space-y-2 border-t border-border pt-4" aria-label="Apply now">
            <p className="text-sm font-medium text-foreground">Apply now</p>
            <p className="text-xs text-muted">
              Runs a platform's evening upload straight away with the saved settings: tomorrow's
              picks replace what the tool put there. Use it after a change saved later than the
              evening run.
            </p>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ['algotest-evening', 'AlgoTest'],
                  ['quantiply-evening', 'Quantiply'],
                ] as const
              ).map(([job, platform]) => (
                <Button
                  key={job}
                  variant="secondary"
                  size="sm"
                  onClick={() => void applyNow(job, platform)}
                  loading={applying === job}
                  disabled={changes.length > 0 || applying !== null}
                >
                  Apply now: {platform}
                </Button>
              ))}
            </div>
            {changes.length > 0 ? (
              <p className="text-xs text-muted">Save or discard your changes first.</p>
            ) : null}
          </section>

          {view.history.length > 1 ? (
            <Accordion
              title="History"
              defaultOpen={false}
              badge={<Badge tone="neutral">{view.history.length}</Badge>}
            >
              <ol className="space-y-3 text-xs">
                {view.history.map((v, i) => {
                  const previous = view.history[i + 1];
                  const lines = previous ? describeChanges(previous.settings, v.settings) : [];
                  return (
                    <li key={v.version}>
                      <p className="font-medium text-foreground">
                        Version {v.version} · {formatIstDateTime(v.saved_at)}
                      </p>
                      <p className="text-muted">
                        {previous
                          ? lines.length
                            ? lines.join('; ')
                            : 'no change'
                          : 'first saved version'}
                      </p>
                    </li>
                  );
                })}
              </ol>
            </Accordion>
          ) : null}
        </div>
      )}
    </Card>
  );
}
