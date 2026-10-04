import { type NextRequest, NextResponse } from 'next/server';

import { PASSWORD_REALM, checkPassword, gateConfig, upstreamHeaders } from './lib/accessGate';

/**
 * Password gate + upstream service-token injection for a remotely served
 * dashboard. Both are no-ops under plain local `next dev` with no env set.
 * Logic and rationale live in lib/accessGate.ts.
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const config = gateConfig(process.env);

  const decision = await checkPassword(request.headers.get('authorization'), config);
  if (decision.kind === 'misconfigured') {
    return new NextResponse('DASHBOARD_PASSWORD not configured', { status: 503 });
  }
  if (decision.kind === 'challenge') {
    return new NextResponse('Password required', {
      status: 401,
      headers: { 'WWW-Authenticate': `Basic realm="${PASSWORD_REALM}", charset="UTF-8"` },
    });
  }

  const pathname = request.nextUrl.pathname;
  if (pathname.startsWith('/api/') || pathname.startsWith('/retrospection/')) {
    const headers = upstreamHeaders(request.headers, config);
    if (headers) return NextResponse.next({ request: { headers } });
  }
  return NextResponse.next();
}

export const config = {
  // Everything except Next's immutable build assets.
  matcher: ['/((?!_next/static).*)'],
};
