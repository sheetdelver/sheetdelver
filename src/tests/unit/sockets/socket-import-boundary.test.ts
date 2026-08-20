/**
 * ADR-0032 Phase 0: executable transport import boundary.
 *
 * The AST walk inspects imports instead of text so comments and neutral type
 * names cannot trigger false positives.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SOCKET_FILES = [
    'src/server/core/foundry/sockets/SocketBase.ts',
    'src/server/core/foundry/sockets/CoreSocket.ts',
    'src/server/core/foundry/sockets/ClientSocket.ts',
] as const;

interface ImportViolation {
    file: string;
    specifier: string;
    target: string;
}

export function run() {
    const violations = SOCKET_FILES.flatMap(findImportViolations);
    assert.deepEqual(
        violations,
        [],
        `Foundry socket transports import application-owned modules:\n${violations
            .map(({ file, specifier }) => `  ${file} -> ${specifier}`)
            .join('\n')}`,
    );
    console.log('  - Socket import boundary: all checks passed');
}

function findImportViolations(relativeFile: string): ImportViolation[] {
    const absoluteFile = path.join(process.cwd(), relativeFile);
    const sourceFile = ts.createSourceFile(
        absoluteFile,
        fs.readFileSync(absoluteFile, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );

    const violations: ImportViolation[] = [];
    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const specifier = statement.moduleSpecifier.text;
        const target = resolveProjectImport(absoluteFile, specifier);
        if (target && isApplicationOwnedTarget(target)) {
            violations.push({ file: relativeFile, specifier, target });
        }
    }
    return violations;
}

function resolveProjectImport(importingFile: string, specifier: string): string | null {
    if (specifier.startsWith('.')) return path.resolve(path.dirname(importingFile), specifier);
    if (specifier.startsWith('@server/')) return path.join(process.cwd(), 'src/server', specifier.slice(8));
    if (specifier.startsWith('@core/')) return path.join(process.cwd(), 'src/server/core', specifier.slice(6));
    if (specifier.startsWith('@modules/')) return path.join(process.cwd(), 'src/modules', specifier.slice(9));
    return null;
}

function isApplicationOwnedTarget(target: string): boolean {
    const relativeTarget = path.relative(process.cwd(), target).split(path.sep).join('/');

    // Application document, service, registry, and world-state ownership stays
    // above transport; neutral contracts and transport utilities remain valid.
    return relativeTarget.startsWith('src/server/core/documents/')
        || relativeTarget.startsWith('src/server/services/')
        || relativeTarget.startsWith('src/modules/registry/')
        || relativeTarget.startsWith('src/server/core/world/');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        run();
        console.log('socket-import-boundary.test.ts passed');
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
}
