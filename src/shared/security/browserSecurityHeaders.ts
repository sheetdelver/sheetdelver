export const CSP_REPORT_PATH = '/api/csp-report';

interface BrowserSecurityHeaderOptions {
    nonce: string;
    isDevelopment: boolean;
    secureTransport: boolean;
}

/** Build the observed policy once so Proxy and tests cannot drift by directive. */
export function createContentSecurityPolicy(nonce: string, isDevelopment: boolean): string {
    const scriptSources = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
    if (isDevelopment) scriptSources.push("'unsafe-eval'");

    return [
        "default-src 'self'",
        `script-src ${scriptSources.join(' ')}`,
        // Existing React style attributes are inert CSS and remain supported;
        // executable content is constrained independently by script-src.
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: http: https:",
        "media-src 'self' blob: http: https:",
        "font-src 'self' data:",
        "connect-src 'self' ws: wss:",
        "worker-src 'self' blob:",
        "manifest-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        `report-uri ${CSP_REPORT_PATH}`,
    ].join('; ');
}

/** Apply the centralized shell policy without turning report-only into enforcement. */
export function applyBrowserSecurityHeaders(headers: Headers, options: BrowserSecurityHeaderOptions): void {
    headers.set(
        'Content-Security-Policy-Report-Only',
        createContentSecurityPolicy(options.nonce, options.isDevelopment),
    );
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Referrer-Policy', 'same-origin');
    headers.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()');

    // Browsers must only receive HSTS from a request that actually reached the
    // shell over HTTPS; local HTTP development must remain usable.
    if (options.secureTransport) {
        headers.set('Strict-Transport-Security', 'max-age=31536000');
    }
}
