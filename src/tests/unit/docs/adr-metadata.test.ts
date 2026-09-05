import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const RECOGNIZED_STATUS = /^(Proposed|Accepted|Implemented|Completed|Superseded|Rejected|Deprecated)\b/;

export function run() {
    const adrDir = path.join(process.cwd(), 'docs', 'adr');
    const adrFiles = fs.readdirSync(adrDir)
        .filter((file) => /^\d{4}.*\.md$/.test(file))
        .sort();

    assert.ok(adrFiles.length > 0, 'Expected tracked ADR files under docs/adr');

    for (const file of adrFiles) {
        const source = fs.readFileSync(path.join(adrDir, file), 'utf8');
        // Status is top-level metadata, so only inspect the header before the first divider.
        const header = source.split(/^---\s*$/m, 1)[0];
        const status = header.match(/^\*\*Status:\*\*\s+(.+)$/m)?.[1]?.trim();

        assert.ok(status, `${file} must declare top-level **Status:** metadata`);
        assert.match(status, RECOGNIZED_STATUS, `${file} has unrecognized ADR status: ${status}`);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
    console.log('adr-metadata.test.ts passed');
}
