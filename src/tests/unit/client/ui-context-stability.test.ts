import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

export function run() {
    // This source-contract guard protects the UI -> Session -> Realtime dependency chain.
    // It does not replace the live socket lifecycle check.
    const source = ts.createSourceFile('UIContext.tsx', readFileSync(
        new URL('../../../client/ui/context/UIContext.tsx', import.meta.url), 'utf8',
    ), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const callbacks = new Set(['resetUI', 'toggleDiceTray', 'toggleJournal', 'togglePlayerList']);
    function visit(node: ts.Node) {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && callbacks.has(node.name.text)) {
            const call = node.initializer;
            assert.ok(call && ts.isCallExpression(call), `${node.name.text} must be memoized`);
            assert.equal(call.expression.getText(source), 'useCallback');
            const dependencies = call.arguments[1];
            assert.ok(dependencies && ts.isArrayLiteralExpression(dependencies));
            assert.equal(dependencies.elements.length, 0, `${node.name.text} must not depend on panel state`);
            callbacks.delete(node.name.text);
        }
        ts.forEachChild(node, visit);
    }
    visit(source);
    assert.equal(callbacks.size, 0, 'all UI action callbacks were checked');
}
