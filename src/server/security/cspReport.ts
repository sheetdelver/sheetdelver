interface CspReportSummary {
    blockedResource: string;
    documentPath: string;
    effectiveDirective: string;
    disposition: string;
}

const MAX_REPORTS_PER_REQUEST = 10;

/** Reduce attacker-controlled reports to bounded fields that are safe to log. */
export function summarizeCspReports(body: unknown): CspReportSummary[] {
    const entries = Array.isArray(body) ? body.slice(0, MAX_REPORTS_PER_REQUEST) : [body];
    return entries.flatMap((entry) => {
        const report = readReport(entry);
        if (!report) return [];

        return [{
            blockedResource: summarizeLocation(readString(report, 'blocked-uri', 'blockedURL')),
            documentPath: summarizeLocation(readString(report, 'document-uri', 'url')),
            effectiveDirective: bound(readString(report, 'effective-directive', 'effectiveDirective'), 80),
            disposition: bound(readString(report, 'disposition'), 20),
        }];
    });
}

function readReport(value: unknown): Record<string, unknown> | undefined {
    if (!isRecord(value)) return undefined;
    const legacy = value['csp-report'];
    if (isRecord(legacy)) return legacy;
    const modernBody = value.body;
    return isRecord(modernBody) ? modernBody : value;
}

function readString(value: Record<string, unknown>, ...keys: string[]): string {
    for (const key of keys) {
        if (typeof value[key] === 'string') return value[key];
    }
    return '';
}

function summarizeLocation(value: string): string {
    const bounded = bound(value, 2048);
    if (!bounded) return '';
    if (/^(?:inline|eval|data|blob)$/i.test(bounded)) return bounded.toLowerCase();

    try {
        const url = new URL(bounded);
        return bound(`${url.origin}${url.pathname}`, 240);
    } catch {
        return bound(bounded.replace(/[?#].*$/, ''), 240);
    }
}

function bound(value: string, limit: number): string {
    return value.replace(/[\r\n\u0000-\u001f\u007f]/g, '').slice(0, limit);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
