import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  applyBrowserSecurityHeaders,
  createContentSecurityPolicy,
} from '@shared/security/browserSecurityHeaders';
import { isAdminRequestHostAllowed } from '@shared/security/adminOrigin';

function normalizeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isAdminPage = pathname === '/admin' || pathname.startsWith('/admin/');
  const isAdminApi = pathname === '/api/admin' || pathname.startsWith('/api/admin/');
  if (isAdminPage || isAdminApi) {
    const expectedOrigin = process.env.APP_ADMIN_ORIGIN || 'http://localhost:3000';
    if (!isAdminRequestHostAllowed(request.headers.get('host'), expectedOrigin)) {
      // The external player hostname must not advertise or proxy the local
      // control plane, even though both route graphs share one Next process.
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    if (isAdminApi) {
      const requestOrigin = request.headers.get('origin');
      const fetchSite = request.headers.get('sec-fetch-site')?.toLowerCase();
      if ((requestOrigin !== null && normalizeOrigin(requestOrigin) !== expectedOrigin)
        || (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none')) {
        return NextResponse.json({ error: 'Admin API requires the configured local origin' }, { status: 403 });
      }
    }
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const policy = createContentSecurityPolicy(nonce, process.env.NODE_ENV === 'development');
  const requestHeaders = new Headers(request.headers);

  // Next reads the request CSP to nonce its generated framework scripts. The
  // browser receives only the report-only response policy during observation.
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  applyBrowserSecurityHeaders(response.headers, {
    nonce,
    isDevelopment: process.env.NODE_ENV === 'development',
    // HAProxy terminates local TLS, so prefer its protocol assertion when set.
    secureTransport: request.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https'
      || request.nextUrl.protocol === 'https:',
  });
  return response;
}

export const config = {
  // API/socket responses do not render executable HTML. Admin API requests are
  // matched so host/origin policy runs before the Core rewrite.
  matcher: [
    '/api/admin/:path*',
    '/((?!api|socket.io|_next/static|_next/image|favicon.ico).*)',
  ],
};
