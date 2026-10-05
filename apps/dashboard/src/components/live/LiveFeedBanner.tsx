/**
 * The banner over the Live tab: simulation mode, or broker-token trouble with the Fyers Login
 * button inline. What it says and in which tone is `tokenBanner` in lib/live.ts.
 */

import { ExternalLink, FlaskConical, LogIn, TriangleAlert } from 'lucide-react';

import { cn } from '../../lib/cn';
import { startFyersLogin } from '../../lib/fyers-login';
import type { TokenBanner } from '../../lib/live';
import { Button } from '../ui/Button';

const TONE_CLASS: Record<TokenBanner['tone'], string> = {
  info: 'border-info/25 bg-info/10 text-info',
  warning: 'border-warning/25 bg-warning/15 text-warning',
  negative: 'border-negative/25 bg-negative/10 text-negative',
};

export function LiveFeedBanner({ banner }: { banner: TokenBanner }) {
  const Icon = banner.tone === 'info' ? FlaskConical : TriangleAlert;
  const body = (
    <>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      {/* spans, not div/p: <output> may only hold phrasing content */}
      <span className="block min-w-0 flex-1">
        <span className="block text-sm font-medium">{banner.title}</span>
        <span className="mt-0.5 block text-xs text-muted">{banner.detail}</span>
      </span>
      {banner.canLogin ? (
        <Button size="sm" variant="secondary" onClick={startFyersLogin} className="shrink-0">
          <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
          Login with Fyers
          <ExternalLink className="h-3 w-3 opacity-60" aria-hidden="true" />
        </Button>
      ) : null}
    </>
  );
  const classes = cn(
    'flex flex-wrap items-start gap-3 rounded-lg border px-3 py-2.5',
    TONE_CLASS[banner.tone],
  );

  // An expired token is an alert; simulation and warnings are status.
  return banner.tone === 'negative' ? (
    <div role="alert" className={classes}>
      {body}
    </div>
  ) : (
    <output className={classes}>{body}</output>
  );
}
