import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { feedbackClearance } from '../../../client/ui/components/Notifications/feedbackLayout';

export function run() {
    assert.equal(feedbackClearance(844, []), null);
    assert.deepEqual(feedbackClearance(844, [{ top: 266, bottom: 748, height: 482 }]), { bottom: 586, maxHeight: 242 });
    assert.deepEqual(feedbackClearance(900, [{ top: 400, bottom: 800, height: 400 }, { top: 250, bottom: 700, height: 450 }]), { bottom: 658, maxHeight: 226 });
    assert.equal(feedbackClearance(844, [{ top: 844, bottom: 900, height: 56 }, { top: 0, bottom: 0, height: 0 }]), null);
    assert.deepEqual(feedbackClearance(400, [{ top: 10, bottom: 390, height: 380 }]), { bottom: 398, maxHeight: 0 });

    // Source-contract guard complements the real-component browser interaction check.
    for (const file of ['GlobalChat.tsx', 'DiceTrayDialog.tsx']) {
        const source = ts.createSourceFile(file, readFileSync(
            new URL(`../../../client/ui/components/${file}`, import.meta.url), 'utf8',
        ), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        let checked = 0;
        function visit(node: ts.Node) {
            if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'DiceTray') {
                const attr = node.attributes.properties.find(property =>
                    ts.isJsxAttribute(property) && property.name.getText(source) === 'onSend');
                assert.ok(attr && ts.isJsxAttribute(attr) && attr.initializer && ts.isJsxExpression(attr.initializer));
                const calls: string[] = [];
                function collect(child: ts.Node) {
                    if (ts.isCallExpression(child)) calls.push(child.expression.getText(source));
                    ts.forEachChild(child, collect);
                }
                collect(attr.initializer);
                assert.deepEqual(calls, ['onSend'], `${file}: sending must not toggle or close the tray`);
                checked++;
            }
            ts.forEachChild(node, visit);
        }
        visit(source);
        assert.equal(checked, 1, `${file}: checked the tray send handler`);
    }
}
