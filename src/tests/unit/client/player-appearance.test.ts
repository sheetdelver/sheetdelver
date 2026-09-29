import assert from 'node:assert/strict';
import { PLAYER_APPEARANCE_KEY, readPlayerAppearance } from '@client/ui/context/PlayerAppearanceContext';

export function run() {
    const storage = (value: string | null) => ({ getItem: (key: string) => {
        assert.equal(key, PLAYER_APPEARANCE_KEY);
        return value;
    } });

    assert.equal(readPlayerAppearance(storage(null)), 'dark');
    assert.equal(readPlayerAppearance(storage('dark')), 'dark');
    assert.equal(readPlayerAppearance(storage('light')), 'light');
    assert.equal(readPlayerAppearance(storage('unexpected')), 'dark');
    assert.equal(readPlayerAppearance({ getItem: () => { throw new Error('storage denied'); } }), 'dark');
    assert.notEqual(PLAYER_APPEARANCE_KEY, 'admin-theme');
}
