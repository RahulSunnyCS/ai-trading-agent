import { type NextRequest, NextResponse } from 'next/server';

import {
  type AttemptStore,
  type GateConfig,
  PASSWORD_MISSING_REASON,
  PASSWORD_REALM,
  UNAVAILABLE_MESSAGE,
  basicAuthPassword,
  clearFailures,
  clientIp,
  gateConfig,
  isApiPath,
  isCrossSiteApiWrite,
  isPageRequest,
  lockoutSeconds,
  passwordMatches,
  recordFailure,
  safeNextPath,
  upstreamHeaders,
} from './lib/accessGate';
import {
  SESSION_COOKIE,
  clearedSessionCookie,
  sessionCookie,
  signSession,
  verifySession,
} from './lib/session';

/**
 * Login gate + upstream service-token injection for a remotely served dashboard. Both are
 * no-ops under plain local `next dev` with no env set. The pure logic and its rationale live
 * in lib/accessGate.ts and lib/session.ts; docs/remote-dashboard.md has the operator's view.
 *
 * The login POST and /logout are answered here rather than in route handlers on purpose: a
 * route handler runs in a different module instance (and possibly a different runtime) from
 * the middleware, so the wrong-password counter below could not be shared between the login
 * form and Basic auth.
 *
 * Order of checks for every request:
 *   1. broken deployment            -> 503 (generic body; reason in the server log)
 *   1a. cross-site API write (CSRF) -> 403, even in open local dev
 *   2. /logout                      -> clear cookie, redirect to /login
 *   3. POST /login                  -> check password, set cookie, redirect to `next`
 *   4. valid session cookie         -> through
 *   5. Basic auth                   -> through, or 401 / 429
 *   6. GET /login                   -> the login page
 *   7. anything else                -> page request: redirect to /login; otherwise 401
 */

/**
 * Wrong-password counts per client IP. In memory, so per instance: it resets on restart or
 * cold start and is not shared between edge instances. See the note on AttemptStore.
 */
const attempts: AttemptStore = new Map();

const LOGIN_PATH = '/login';
const LOGOUT_PATH = '/logout';
const MAX_LOGIN_BODY_BYTES = 8192;
const NO_STORE = { 'Cache-Control': 'no-store' };

function unavailable(reason: string): NextResponse {
  console.error(`[dashboard gate] refusing every request: ${reason}`);
  return new NextResponse(UNAVAILABLE_MESSAGE, { status: 503, headers: NO_STORE });
}

function isSecure(request: NextRequest): boolean {
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  return request.nextUrl.protocol === 'https:' || forwarded === 'https';
}

/** `to` is always a path we built ourselves; resolving it against the request keeps it same-origin. */
function redirect(request: NextRequest, to: string, status: 302 | 303): NextResponse {
  return NextResponse.redirect(new URL(to, request.url), { status, headers: NO_STORE });
}

function loginUrl(next: string, error?: 'invalid' | 'locked'): string {
  const params = new URLSearchParams();
  if (error) params.set('error', error);
  if (next !== '/') params.set('next', next);
  const query = params.toString();
  return query ? `${LOGIN_PATH}?${query}` : LOGIN_PATH;
}

function tooManyAttempts(retryAfterSeconds: number, loginPage: string | null): NextResponse {
  const headers = { ...NO_STORE, 'Retry-After': String(retryAfterSeconds) };
  if (loginPage === null) {
    return new NextResponse('Too many attempts. Try again in a few minutes.', {
      status: 429,
      headers,
    });
  }
  // A 429 cannot redirect, so the body sends a browser straight back to the login page, which
  // shows the same message in the app's own styling. `loginPage` is built by loginUrl().
  const href = loginPage.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${href}"><title>Too many attempts</title></head><body><p>Too many attempts. Try again in a few minutes.</p><p><a href="${href}">Back to login</a></p></body></html>`;
  return new NextResponse(body, {
    status: 429,
    headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/** Lets the request through, with the upstream service token on API paths. */
function forward(request: NextRequest, config: GateConfig): NextResponse {
  if (isApiPath(request.nextUrl.pathname)) {
    const headers = upstreamHeaders(request.headers, config);
    if (headers) return NextResponse.next({ request: { headers } });
  }
  return NextResponse.next();
}

async function handleLogin(request: NextRequest, password: string | null): Promise<NextResponse> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  let form: FormData | null = null;
  if (!(declared > MAX_LOGIN_BODY_BYTES)) {
    try {
      form = await request.formData();
    } catch {
      form = null;
    }
  }
  const field = (name: string): string | null => {
    const value = form?.get(name);
    return typeof value === 'string' ? value : null;
  };
  const next = safeNextPath(field('next'));

  // Open local dev: nothing to check, nothing to issue.
  if (password === null) return redirect(request, next, 303);

  const ip = clientIp(request.headers.get('x-forwarded-for'));
  const now = Date.now();
  const locked = lockoutSeconds(attempts, ip, now);
  if (locked > 0) return tooManyAttempts(locked, loginUrl(next, 'locked'));

  const supplied = field('password');
  if (supplied === null || !(await passwordMatches(supplied, password))) {
    const lockout = recordFailure(attempts, ip, now);
    if (lockout > 0) return tooManyAttempts(lockout, loginUrl(next, 'locked'));
    return redirect(request, loginUrl(next, 'invalid'), 303);
  }

  clearFailures(attempts, ip);
  const response = redirect(request, next, 303);
  response.headers.append(
    'Set-Cookie',
    sessionCookie(await signSession(password, now), isSecure(request)),
  );
  return response;
}

function unauthenticated(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  if (isPageRequest(request.method, pathname, request.headers.get('accept'))) {
    return redirect(request, loginUrl(safeNextPath(`${pathname}${search}`)), 302);
  }
  // A browser's own fetch()/XHR/image request announces itself with Sec-Fetch-Mode. Leaving
  // the Basic challenge off those stops the native password prompt reappearing when a session
  // runs out mid-use; curl, scripts and a direct navigation still get the challenge.
  const fetchMode = request.headers.get('sec-fetch-mode');
  const challenge = fetchMode === null || fetchMode === 'navigate';
  return new NextResponse('Password required', {
    status: 401,
    headers: {
      ...NO_STORE,
      ...(challenge
        ? { 'WWW-Authenticate': `Basic realm="${PASSWORD_REALM}", charset="UTF-8"` }
        : {}),
    },
  });
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const config = gateConfig(process.env);
  if (config.configError) return unavailable(config.configError);
  const { password } = config;
  if (password === null && config.passwordRequired) return unavailable(PASSWORD_MISSING_REASON);

  const { pathname } = request.nextUrl;
  const method = request.method;

  if (isCrossSiteApiWrite(method, pathname, request.headers, request.nextUrl.host)) {
    return new NextResponse('Cross-site request refused', { status: 403, headers: NO_STORE });
  }

  if (pathname === LOGOUT_PATH) {
    const response = redirect(request, LOGIN_PATH, 303);
    response.headers.append('Set-Cookie', clearedSessionCookie(isSecure(request)));
    return response;
  }

  if (pathname === LOGIN_PATH && method === 'POST') return handleLogin(request, password);

  const onLoginPage = pathname === LOGIN_PATH && (method === 'GET' || method === 'HEAD');
  const afterLogin = () =>
    redirect(request, safeNextPath(request.nextUrl.searchParams.get('next')), 302);

  // Open local dev (no password, none required). /login still renders, so the page can be
  // looked at while developing; submitting it just moves on.
  if (password === null) return forward(request, config);

  const now = Date.now();
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (await verifySession(token, password, now)) {
    return onLoginPage ? afterLogin() : forward(request, config);
  }

  const supplied = basicAuthPassword(request.headers.get('authorization'));
  if (supplied !== null) {
    const ip = clientIp(request.headers.get('x-forwarded-for'));
    const locked = lockoutSeconds(attempts, ip, now);
    if (locked > 0) return tooManyAttempts(locked, null);
    if (await passwordMatches(supplied, password)) {
      clearFailures(attempts, ip);
      return onLoginPage ? afterLogin() : forward(request, config);
    }
    const lockout = recordFailure(attempts, ip, now);
    if (lockout > 0) return tooManyAttempts(lockout, null);
    return unauthenticated(request);
  }

  if (onLoginPage) return NextResponse.next();
  return unauthenticated(request);
}

export const config = {
  // Everything except Next's immutable build assets (the login page's CSS, JS and fonts).
  matcher: ['/((?!_next/static).*)'],
};
