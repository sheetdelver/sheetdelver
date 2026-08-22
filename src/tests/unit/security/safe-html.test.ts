import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { sanitizeRichHtml } from '@shared/security/safeHtml';

const RAW_HTML_BOUNDARY = 'src/client/ui/components/SafeHtmlContent.tsx';

export function run(): void {
    runFoundryMarkupCases();
    runAdversarialCases();
    runRawSinkArchitectureGuard();
    console.log('  - SafeHtml sanitizer and rendering boundary: all checks passed');
}

function runFoundryMarkupCases(): void {
    const sanitized = sanitizeRichHtml([
        '<section class="chat-card" style="color:red">',
        '<p><strong>Result</strong> <a class="content-link" draggable="true" data-link data-uuid="Actor.abc" href="journal/entry">Entry</a></p>',
        '<figure class="content-embed" data-content-embed data-uuid="JournalEntry.abc"><figcaption>Reference</figcaption></figure>',
        '<button data-action="roll-formula" data-formula="1d20+4">Roll</button>',
        '<img class="result-image" src="icons/item.png" alt="Item">',
        '<table><tbody><tr><th scope="row">Total</th><td colspan="2">14</td></tr></tbody></table>',
        '</section>',
    ].join(''), { foundryBaseUrl: 'https://foundry.test/' });

    assert.match(sanitized, /class="chat-card"/);
    assert.match(sanitized, /data-uuid="Actor\.abc"/);
    assert.match(sanitized, /draggable="true"/);
    assert.match(sanitized, /data-link/);
    assert.match(sanitized, /data-content-embed/);
    assert.match(sanitized, /href="https:\/\/foundry\.test\/journal\/entry"/);
    assert.match(sanitized, /data-action="roll-formula"/);
    assert.match(sanitized, /src="https:\/\/foundry\.test\/icons\/item\.png"/);
    assert.match(sanitized, /<table>/);
    assert.doesNotMatch(sanitized, /style=/i);
}

function runAdversarialCases(): void {
    const sanitized = sanitizeRichHtml([
        '<script>alert(1)</script>',
        '<img src=x onerror="alert(2)">',
        '<a href="javascript:alert(3)" onclick="alert(4)">bad link</a>',
        '<a href="jav&#x61;script:alert(3)">encoded bad link</a>',
        '<a href="JaVaScRiPt:alert(3)">mixed-case bad link</a>',
        '<img src="data:image/svg+xml;base64,PHN2Zz4=">',
        '<img src=x/onerror=alert(4)>',
        '<svg><script>alert(5)</script></svg>',
        '<math><mtext>unsafe</mtext></math>',
        '<iframe srcdoc="<script>alert(6)</script>"></iframe>',
        '<div style="background:url(javascript:alert(7))">safe text</div>',
    ].join(''), { foundryBaseUrl: 'https://foundry.test' });

    assert.doesNotMatch(
        sanitized,
        /<(?:script|iframe|svg|math)\b|\s(?:onerror|onclick|srcdoc|style)\s*=|(?:href|src)="javascript:/i,
    );
    assert.match(sanitized, /bad link/);
    assert.match(sanitized, /encoded bad link/);
    assert.match(sanitized, /mixed-case bad link/);
    assert.match(sanitized, /safe text/);
    assert.doesNotMatch(sanitized, /image\/svg/i);

    const safeRaster = sanitizeRichHtml('<img src="data:image/png;base64,iVBORw0KGgo=">');
    assert.match(safeRaster, /data:image\/png;base64,iVBORw0KGgo=/);
}

function runRawSinkArchitectureGuard(): void {
    const sourceRoot = path.join(process.cwd(), 'src');
    const violations: string[] = [];

    for (const file of walkSourceFiles(sourceRoot)) {
        const relativeFile = path.relative(process.cwd(), file).split(path.sep).join('/');
        if (relativeFile === RAW_HTML_BOUNDARY) continue;

        const sourceFile = ts.createSourceFile(
            file,
            fs.readFileSync(file, 'utf8'),
            ts.ScriptTarget.Latest,
            true,
            file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        );

        const visit = (node: ts.Node): void => {
            if (ts.isJsxAttribute(node) && node.name.getText(sourceFile) === 'dangerouslySetInnerHTML') {
                violations.push(relativeFile);
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
    }

    assert.deepEqual(violations, [], `Raw HTML sinks exist outside ${RAW_HTML_BOUNDARY}: ${violations.join(', ')}`);
}

function walkSourceFiles(directory: string): string[] {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) return walkSourceFiles(target);
        return /\.(?:ts|tsx)$/.test(entry.name) ? [target] : [];
    });
}
