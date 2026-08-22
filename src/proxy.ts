import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  applyBrowserSecurityHeaders,
  createContentSecurityPolicy,
} from '@shared/security/browserSecurityHeaders';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname.toLowerCase());
}

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if ((pathname.startsWith('/admin') || pathname.startsWith('/api/admin'))
    && !isLocalHostname(request.nextUrl.hostname)) {
    return NextResponse.json({ error: 'Admin access restricted to localhost' }, { status: 403 });
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
    secureTransport: request.nextUrl.protocol === 'https:',
  });
  return response;
}

export const config = {
  // API/socket responses do not render executable HTML. The explicit admin API
  // matcher preserves its loopback guard without adding nonce work to all APIs.
  matcher: [
    '/api/admin/:path*',
    '/((?!api|socket.io|_next/static|_next/image|favicon.ico).*)',
  ],
};
