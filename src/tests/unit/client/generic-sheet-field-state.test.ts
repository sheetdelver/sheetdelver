import { strict as assert } from 'node:assert';
import {
    beginPrimitiveEdit,
    commitPrimitiveEdit,
    shouldUseMultilineField,
    updatePrimitiveDraft,
} from '@client/ui/components/genericSheetFieldState';

export function run() {
    const originalHtml = '<p>Original background</p>';
    const untouched = beginPrimitiveEdit(originalHtml);
    assert.equal(untouched.draft, originalHtml);
    assert.deepEqual(
        commitPrimitiveEdit(untouched),
        { changed: false, value: originalHtml },
        'focus and blur without user input is not a mutation',
    );

    const refreshed = beginPrimitiveEdit('<p>Refreshed background</p>');
    assert.equal(
        refreshed.draft,
        '<p>Refreshed background</p>',
        'entering edit mode snapshots the latest realtime value',
    );

    const changed = updatePrimitiveDraft(refreshed, '<p>Player background</p>');
    assert.deepEqual(
        commitPrimitiveEdit(changed),
        { changed: true, value: '<p>Player background</p>' },
        'changed text produces a mutation',
    );

    const restored = updatePrimitiveDraft(refreshed, refreshed.draft);
    assert.equal(
        commitPrimitiveEdit(restored).changed,
        false,
        'typing back to the original value does not produce a mutation',
    );

    const numeric = updatePrimitiveDraft(beginPrimitiveEdit(3), '4');
    assert.deepEqual(
        commitPrimitiveEdit(numeric),
        { changed: true, value: 4 },
        'numeric controls retain their source type',
    );

    assert.equal(shouldUseMultilineField(originalHtml, 'system.biography.background'), true);
    assert.equal(shouldUseMultilineField('', 'system.biography.connections'), true);
    assert.equal(shouldUseMultilineField('Short name', 'system.name'), false);

    console.log('  - Generic sheet primitive edit state: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) run();
