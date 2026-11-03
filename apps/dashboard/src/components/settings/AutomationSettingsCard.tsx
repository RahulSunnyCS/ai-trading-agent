'use client';

import { useEffect, useMemo, useState } from 'react';

import { usePolledResource } from '../../hooks/usePolledResource';
import { apiPost, apiPut } from '../../lib/api';
import {
  type AutomationSettings,
  type AutomationView,
  BROKERS,
  CAPITAL_MAX,
  CAPITAL_MIN,
  LIST_LABEL,
  type List,
  MASTER_LABEL,
  MTM_SL_MAX,
  MTM_SL_MIN,
  MULTIPLIER_MAX,
  MULTIPLIER_MIN,
  ROWS,
  applyNowOpen,
  defaultMtmSl,
  describeChanges,
  githubOutcome,
  heldByMaster,
  totalCapital,
  withCapital,
  withMaster,
  withPause,
  withRow,
  withViewDefaults,
} from '../../lib/automation';
import { formatDay, formatInr, formatIstDateTime } from '../../lib/format';
import { SCHEDULER_API, runNowError } from '../../lib/scheduler';
import { Accordion } from '../ui/Accordion';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { Input, NumberField } from '../ui/Input';
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
 * backstop reads. The .env switches (ALGOTEST_UPLOAD, QUANTIPLY_UPLOAD, ALGOTEST_DEPLOY,
 * QUANTIPLY_DEPLOY) still have the last word.
 */
export function AutomationSettingsCard() {
  const { data, loading, error, refetch } = usePolledResource<AutomationView>(URL);
  const [view, setView] = useState<AutomationView | null>(null);
  const [draft, setDraft] = useState<AutomationSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const next = withViewDefaults(data);
    setView(next);
    setDraft(next.current.settings);
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
    const next = withViewDefaults(result.data);
    setView(next);
    setDraft(next.current.settings);
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
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                      <label
                        htmlFor={`multiplier-${key}`}
                        className="text-sm font-medium text-foreground"
                      >
                        Multiplier
                        <span className="ml-2 text-xs font-normal text-muted">
                          1 to {MULTIPLIER_MAX}, a whole number.{' '}
                          {platform === 'Quantiply'
                            ? 'Set on each algo the tool creates, then read back; the 09:25 and margin checks expect it.'
                            : 'The deployer never sets it: above 1 it deploys nothing and you deploy by hand; the 09:25 and margin checks expect it.'}
                        </span>
                      </label>
                      <NumberField
                        id={`multiplier-${key}`}
                        className="w-20"
                        min={MULTIPLIER_MIN}
                        max={MULTIPLIER_MAX}
                        step={1}
                        value={row.multiplier}
                        disabled={saving}
                        onChange={(multiplier) =>
                          setDraft(withRow(draft, key, { multiplier: Math.round(multiplier) }))
                        }
                      />
                    </div>
                    {platform === 'Quantiply' ? (
                      <div className="space-y-2">
                        <SettingSwitch
                          label="Keep the clientwise MTM SL"
                          description="Checked every trading day at 08:00, after the login, and set to this figure when it differs (the account's whole MTM, your own algos included). Off leaves it as you set it."
                          checked={row.mtmSl !== null}
                          disabled={saving}
                          onChange={(on) =>
                            setDraft(
                              withRow(draft, key, {
                                mtmSl: on ? (defaultMtmSl(key, row.list) ?? 8000) : null,
                              }),
                            )
                          }
                        />
                        {row.mtmSl !== null ? (
                          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                            <label
                              htmlFor={`mtmsl-${key}`}
                              className="text-sm font-medium text-foreground"
                            >
                              MTM SL (₹)
                              <span className="ml-2 text-xs font-normal text-muted">
                                Whole rupees, {MTM_SL_MIN} to {MTM_SL_MAX}.
                              </span>
                            </label>
                            <NumberField
                              id={`mtmsl-${key}`}
                              className="w-28"
                              min={MTM_SL_MIN}
                              max={MTM_SL_MAX}
                              step={500}
                              value={row.mtmSl}
                              disabled={saving}
                              onChange={(mtmSl) =>
                                setDraft(withRow(draft, key, { mtmSl: Math.round(mtmSl) }))
                              }
                            />
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    <SettingSwitch
                      label="Include the Buy add-on"
                      description="Off leaves the add-on picks out of this list's exports, so they are not uploaded, deployed or checked."
                      checked={row.addon}
                      disabled={saving}
                      onChange={(addon) => setDraft(withRow(draft, key, { addon }))}
                    />
                    <SettingSwitch
                      label="Dir ×2 on non-expiry days"
                      description="On a day neither index expires, the picked Dir is uploaded at 2 lots and its MTM SL doubles (4 lots in all); on expiry days, and when no Dir is picked, every pick stays at 1 lot. On Quantiply the morning job raises the MTM SL above by the Dir's own stop on those days."
                      checked={row.dirBoost}
                      disabled={saving}
                      onChange={(dirBoost) => setDraft(withRow(draft, key, { dirBoost }))}
                    />
                  </div>
                </div>
              );
            })}
          </section>

          <section className="space-y-3 border-t border-border pt-4" aria-label="Capital">
            <div>
              <p className="text-sm font-medium text-foreground">Capital</p>
              <p className="text-xs text-muted">
                The money in each broker account. The evening result message shows each list against
                the capital of the accounts that upload it, and your real month to date (from the
                contract notes) against the total, now {formatInr(totalCapital(draft))}.
              </p>
            </div>
            {BROKERS.map(({ key, label }) => (
              <div
                key={key}
                className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between"
              >
                <label htmlFor={`capital-${key}`} className="text-sm font-medium text-foreground">
                  {label} (₹)
                  <span className="ml-2 text-xs font-normal text-muted">
                    Whole rupees, {formatInr(CAPITAL_MIN)} to {formatInr(CAPITAL_MAX)}.
                  </span>
                </label>
                <NumberField
                  id={`capital-${key}`}
                  className="w-36"
                  min={CAPITAL_MIN}
                  max={CAPITAL_MAX}
                  step={50_000}
                  value={draft.capital[key]}
                  disabled={saving}
                  onChange={(rupees) => setDraft(withCapital(draft, key, Math.round(rupees)))}
                />
              </div>
            ))}
          </section>

          <section className="space-y-3 border-t border-border pt-4" aria-label="Pause">
            <div>
              <p className="text-sm font-medium text-foreground">Pause uploads and deploys</p>
              <p className="text-xs text-muted">
                No uploads, top-ups or deploys for any session up to and including this day. Logins,
                the picks, results and the live capture carry on, and nothing already uploaded or
                enabled is removed (the stop button and the 15:40 switch-off do that).
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="date"
                aria-label="Pause until"
                className="w-44"
                value={draft.pause.until ?? ''}
                min={view.next_session}
                disabled={saving}
                onChange={(event) => setDraft(withPause(draft, event.target.value || null))}
              />
              {view.next_session ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={saving || draft.pause.until === view.next_session}
                  onClick={() => setDraft(withPause(draft, view.next_session ?? null))}
                >
                  Skip next session ({formatDay(view.next_session)})
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                disabled={saving || draft.pause.until === null}
                onClick={() => setDraft(withPause(draft, null))}
              >
                Clear pause
              </Button>
            </div>
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
                  disabled={changes.length > 0 || applying !== null || !applyNowOpen()}
                >
                  Apply now: {platform}
                </Button>
              ))}
            </div>
            {changes.length > 0 ? (
              <p className="text-xs text-muted">Save or discard your changes first.</p>
            ) : !applyNowOpen() ? (
              <p className="text-xs text-muted">
                Available after 15:30 IST, when none of today's picks can still trade.
              </p>
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
