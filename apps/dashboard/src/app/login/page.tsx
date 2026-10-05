import type { Metadata } from 'next';

import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/Input';
import { safeNextPath } from '../../lib/accessGate';
import { LoginTheme } from './LoginTheme';

export const metadata: Metadata = { title: 'Log in · AI Trading Agent' };

const ERRORS: Record<string, string> = {
  invalid: 'Wrong password. Try again.',
  locked: 'Too many attempts. Try again in a few minutes.',
};

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The dashboard's login page. A plain form that POSTs back to /login, so it works without
 * JavaScript; src/middleware.ts answers the POST (password check, session cookie, redirect)
 * and this page only ever renders the form. It deliberately says nothing about configuration.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const error = ERRORS[first(params.error) ?? ''];
  const next = safeNextPath(first(params.next));

  return (
    <LoginTheme>
      <main className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">AI Trading Agent</h1>
          <p className="mt-1 text-sm text-muted">Trading research dashboard</p>
        </div>
        <Card>
          <form method="post" action="/login" className="space-y-4">
            <input type="hidden" name="next" value={next} />
            <div className="space-y-1.5">
              <label htmlFor="password" className="block text-sm font-medium text-foreground">
                Password
              </label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                autoFocus
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'login-error' : undefined}
              />
              {error ? (
                <p id="login-error" role="alert" className="text-sm text-negative">
                  {error}
                </p>
              ) : null}
            </div>
            <Button type="submit" variant="primary" className="w-full">
              Log in
            </Button>
          </form>
        </Card>
      </main>
    </LoginTheme>
  );
}
