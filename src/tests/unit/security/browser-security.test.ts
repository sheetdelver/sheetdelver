import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
    applyBrowserSecurityHeaders,
    createContentSecurityPolicy,
    CSP_REPORT_PATH,
} from '@shared/security/browserSecurityHeaders';
import { summarizeCspReports } from '@server/security/cspReport';

export function run(): void {
    runPolicyAssertions();
    runHeaderAssertions();
    runReportSanitizationAssertions();
    runProxyArchitectureAssertions();
    runPlayerCredentialArchitectureAssertions();
    console.log('  - browser security headers and CSP reporting: all checks passed');
}

function runPolicyAssertions(): void {
    const production = createContentSecurityPolicy('fixed-nonce', false);
    assert.match(production, /script-src 'self' 'nonce-fixed-nonce' 'strict-dynamic'/);
    assert.match(production, /object-src 'none'/);
    assert.match(production, /frame-ancestors 'none'/);
    assert.match(production, new RegExp(`report-uri ${CSP_REPORT_PATH}`));
    assert.doesNotMatch(production, /unsafe-eval/);

    const development = createContentSecurityPolicy('dev-nonce', true);
    assert.match(development, /'unsafe-eval'/);
}

function runHeaderAssertions(): void {
    const httpHeaders = new Headers();
    applyBrowserSecurityHeaders(httpHeaders, {
        nonce: 'http-nonce',
        isDevelopment: false,
        secureTransport: false,
    });

    assert.ok(httpHeaders.get('Content-Security-Policy-Report-Only'));
    assert.equal(httpHeaders.get('Content-Security-Policy'), null);
    assert.equal(httpHeaders.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(httpHeaders.get('X-Frame-Options'), 'DENY');
    assert.equal(httpHeaders.get('Referrer-Policy'), 'same-origin');
    assert.equal(httpHeaders.get('Strict-Transport-Security'), null);

    const httpsHeaders = new Headers();
    applyBrowserSecurityHeaders(httpsHeaders, {
        nonce: 'https-nonce',
        isDevelopment: false,
        secureTransport: true,
    });
    assert.equal(httpsHeaders.get('Strict-Transport-Security'), 'max-age=31536000');
}

function runReportSanitizationAssertions(): void {
    const summaries = summarizeCspReports({
        'csp-report': {
            'blocked-uri': 'https://evil.test/payload.js?secret=hidden',
            'document-uri': 'https://app.test/actors/123?token=hidden',
            'effective-directive': 'script-src-elem\r\nforged-log',
            disposition: 'report',
        },
    });

    assert.deepEqual(summaries, [{
        blockedResource: 'https://evil.test/payload.js',
        documentPath: 'https://app.test/actors/123',
        effectiveDirective: 'script-src-elemforged-log',
        disposition: 'report',
    }]);
}

function runProxyArchitectureAssertions(): void {
    const proxySource = fs.readFileSync(path.join(process.cwd(), 'src', 'proxy.ts'), 'utf8');

    // Keep Next's internal nonce input distinct from the browser's report-only
    // header so a refactor cannot silently enforce an unobserved policy.
    assert.match(proxySource, /requestHeaders\.set\('Content-Security-Policy', policy\)/);
    assert.match(proxySource, /applyBrowserSecurityHeaders\(response\.headers/);
}

function runPlayerCredentialArchitectureAssertions(): void {
    const roots = [
        'src/app/(player)',
        'src/client',
        'src/modules/registry/core',
        'src/shared/sdk',
    ];
    const violations: string[] = [];

    for (const root of roots) {
        for (const file of walkSourceFiles(path.join(process.cwd(), root))) {
            const source = fs.readFileSync(file, 'utf8');
            const relativeFile = path.relative(process.cwd(), file).split(path.sep).join('/');

            // Authentication migration must never erase module settings,
            // themes, roll modes, or other non-secret browser preferences.
            if (/localStorage\.clear\s*\(/.test(source)) {
                violations.push(`${relativeFile}: broad localStorage clear`);
            }

            // Player code may remove the pre-migration key, but it must never
            // read or write the reusable credential again.
            if (/localStorage\.(?:getItem|setItem)\(\s*['"`]sheet-delver-token['"`]/.test(source)) {
                violations.push(`${relativeFile}: legacy token storage`);
            }
            if (/Authorization\s*[:=].*Bearer|Bearer\s+\$\{/s.test(source)) {
                violations.push(`${relativeFile}: browser bearer authorization`);
            }
            if (/auth\s*:\s*\{\s*token\b/s.test(source)) {
                violations.push(`${relativeFile}: Socket.IO auth token`);
            }
        }
    }

    assert.deepEqual(violations, [], `Script-readable player credentials found: ${violations.join(', ')}`);

    const sessionSource = fs.readFileSync(
        path.join(process.cwd(), 'src/client/ui/context/SessionContext.tsx'),
        'utf8',
    );
    const removedKeys = [...sessionSource.matchAll(/localStorage\.removeItem\(\s*['"`]([^'"`]+)['"`]\s*\)/g)]
        .map((match) => match[1]);
    assert.deepEqual(
        removedKeys,
        ['sheet-delver-token'],
        'Session migration may remove only the legacy credential key',
    );
}

function walkSourceFiles(directory: string): string[] {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) return walkSourceFiles(target);
        return /\.(?:ts|tsx)$/.test(entry.name) ? [target] : [];
    });
}
