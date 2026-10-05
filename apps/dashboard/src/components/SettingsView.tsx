'use client';

import { LogOut } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

import { useMeta } from '../hooks/useMeta';
import { EMPTY, formatInt } from '../lib/format';
import type { NavigationPreferences } from '../store/navigation';
import {
  DATE_RANGE_YEAR_CHOICES,
  type Density,
  FULL_HISTORY_YEARS,
  type MomentumDefaultDataset,
  useSettingsStore,
} from '../store/settings';
import { type ThemePreference, useThemeStore } from '../store/theme';
import { NavigationSection } from './settings/NavigationSection';
import { SettingRow, SettingSwitch } from './settings/SettingSwitch';
import { NAV_GROUPS, type Tab } from './shell/nav';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Card, CardHeader } from './ui/Card';
import { Select } from './ui/Input';
import { RadioCards } from './ui/RadioCards';
import { SegmentedControl } from './ui/SegmentedControl';

interface SettingsViewProps {
  preferences: NavigationPreferences;
  onChange: (preferences: NavigationPreferences) => void;
}

/** <select> value for "no preference": the app's own default applies. */
const APP_DEFAULT = '';

function yearsLabel(years: number): string {
  if (years === FULL_HISTORY_YEARS) return 'Full history';
  return `${formatInt(years)} ${years === 1 ? 'year' : 'years'}`;
}

function AppearanceSection() {
  const themePreference = useThemeStore((state) => state.preference);
  const setThemePreference = useThemeStore((state) => state.setPreference);
  const density = useSettingsStore((state) => state.density);
  const setDensity = useSettingsStore((state) => state.setDensity);

  return (
    <Card>
      <CardHeader
        title="Appearance"
        description="Dark is the default. The sun / moon button in the top bar switches between light and dark."
      />
      <div className="space-y-4">
        <RadioCards
          name="theme"
          columns={3}
          value={themePreference}
          onChange={(value) => setThemePreference(value as ThemePreference)}
          options={[
            { value: 'light', label: 'Light', description: 'Always light' },
            { value: 'dark', label: 'Dark', description: 'Always dark' },
            { value: 'system', label: 'System', description: 'Follow this device' },
          ]}
        />
        <SettingRow
          label="Density"
          description="Compact tightens table rows and figures to fit more on screen."
        >
          <SegmentedControl<Density>
            ariaLabel="Density"
            value={density}
            onChange={setDensity}
            options={[
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'compact', label: 'Compact' },
            ]}
          />
        </SettingRow>
      </div>
    </Card>
  );
}

function DefaultsSection({ preferences }: { preferences: NavigationPreferences }) {
  const defaults = useSettingsStore((state) => state.defaults);
  const setDefaults = useSettingsStore((state) => state.setDefaults);

  const hidden = new Set(preferences.hidden);
  const rank = new Map(preferences.order.map((id, index) => [id, index]));
  const landingOptions = NAV_GROUPS.flatMap((group) => group.items)
    .filter((item) => item.id !== 'settings')
    .filter((item) => !hidden.has(item.id) || item.id === defaults.landingTab)
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));

  return (
    <Card>
      <CardHeader
        title="Defaults"
        description="These apply the next time the dashboard opens. Saved in this browser only."
      />
      <div className="space-y-4">
        <SettingRow
          label="Landing tab"
          description="The tab the dashboard opens on."
          htmlFor="settings-landing-tab"
        >
          <Select
            id="settings-landing-tab"
            className="w-full sm:w-56"
            value={defaults.landingTab ?? APP_DEFAULT}
            onChange={(event) =>
              setDefaults({
                landingTab: event.target.value === APP_DEFAULT ? null : (event.target.value as Tab),
              })
            }
          >
            <option value={APP_DEFAULT}>App default</option>
            {landingOptions.map((item) => (
              <option key={item.id} value={item.id}>
                {hidden.has(item.id) ? `${item.label} (hidden)` : item.label}
              </option>
            ))}
          </Select>
        </SettingRow>

        <SettingRow
          label="Momentum dataset"
          description="The dataset Momentum starts on."
          htmlFor="settings-momentum-dataset"
        >
          <Select
            id="settings-momentum-dataset"
            className="w-full sm:w-56"
            value={defaults.momentumDataset ?? APP_DEFAULT}
            onChange={(event) =>
              setDefaults({
                momentumDataset:
                  event.target.value === APP_DEFAULT
                    ? null
                    : (event.target.value as MomentumDefaultDataset),
              })
            }
          >
            <option value={APP_DEFAULT}>App default</option>
            <option value="etf">ETF Rotation</option>
            <option value="broad">Broad Momentum</option>
          </Select>
        </SettingRow>

        <SettingRow
          label="Backtest period"
          description="How much history a new backtest starts with."
          htmlFor="settings-date-range"
        >
          <Select
            id="settings-date-range"
            className="w-full sm:w-56"
            value={defaults.dateRangeYears === null ? APP_DEFAULT : String(defaults.dateRangeYears)}
            onChange={(event) =>
              setDefaults({
                dateRangeYears:
                  event.target.value === APP_DEFAULT ? null : Number(event.target.value),
              })
            }
          >
            <option value={APP_DEFAULT}>App default</option>
            {DATE_RANGE_YEAR_CHOICES.map((years) => (
              <option key={years} value={String(years)}>
                {yearsLabel(years)}
              </option>
            ))}
          </Select>
        </SettingRow>
      </div>
    </Card>
  );
}

function NotificationsSection() {
  const tokenExpiry = useSettingsStore((state) => state.notifications.tokenExpiry);
  const setNotifications = useSettingsStore((state) => state.setNotifications);

  return (
    <Card>
      <CardHeader
        title="Notifications"
        description="Alerts such as the weekly signal and broker login results go to Telegram. Delivery is configured on the server, so there is nothing to set up here."
      />
      <SettingSwitch
        label="Warn me in the dashboard before the Fyers token expires"
        description="Applies to this browser only."
        checked={tokenExpiry}
        onChange={(checked) => setNotifications({ tokenExpiry: checked })}
      />
    </Card>
  );
}

function AccountSection() {
  return (
    <Card>
      <CardHeader
        title="Account"
        description="This dashboard is protected by a single shared password."
        actions={
          <Button asChild variant="secondary" size="sm">
            <a href="/logout">
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" /> Log out
            </a>
          </Button>
        }
      />
    </Card>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-sm text-foreground">{children}</dd>
    </div>
  );
}

function AboutSection() {
  const { meta, loading } = useMeta();
  const developer = useSettingsStore((state) => state.developer);
  const setDeveloper = useSettingsStore((state) => state.setDeveloper);
  // Read after mount: the server render has no window, and the two must match.
  const [origin, setOrigin] = useState<string | null>(null);
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const unavailable = <span className="text-faint">{loading ? 'Loading…' : 'Unavailable'}</span>;

  return (
    <Card>
      <CardHeader title="About" description="What this dashboard is connected to." />
      <dl className="divide-y divide-border">
        <Fact label="Mode">
          {meta ? (
            <Badge tone={meta.simulate ? 'warning' : 'positive'}>
              {meta.simulate ? 'Simulation' : 'Live market data'}
            </Badge>
          ) : (
            unavailable
          )}
        </Fact>
        <Fact label="Broker">{meta ? meta.broker || EMPTY : unavailable}</Fact>
        <Fact label="Broker sign-in">
          {meta ? (
            <Badge status={meta.authDegraded ? 'attention' : 'connected'}>
              {meta.authDegraded ? 'Needs attention' : 'OK'}
            </Badge>
          ) : (
            unavailable
          )}
        </Fact>
        <Fact label="Address">
          <span className="font-mono text-xs">{origin ?? EMPTY}</span>
        </Fact>
      </dl>
      <div className="mt-4 border-t border-border pt-4">
        <SettingSwitch
          label="Developer mode"
          description="Shows the pending-work notes in each tab's header."
          checked={developer}
          onChange={setDeveloper}
        />
      </div>
    </Card>
  );
}

export function SettingsView({ preferences, onChange }: SettingsViewProps) {
  return (
    <div className="space-y-5">
      <AppearanceSection />
      <NavigationSection preferences={preferences} onChange={onChange} />
      <DefaultsSection preferences={preferences} />
      <NotificationsSection />
      <AccountSection />
      <AboutSection />
    </div>
  );
}
