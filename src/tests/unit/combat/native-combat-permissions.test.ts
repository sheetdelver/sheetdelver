import assert from 'node:assert/strict';
import { FoundryUserRole } from '@server/core/documents/primary/base/ownership';
import { canReadCombatActorPack, hasCombatCopyPermission }
    from '@server/core/documents/primary/base/nativeCombatPermissions';

export function run() {
    for (const role of [0, 1, 2, 3, 4]) {
        const subject = { userId: `user-${role}`, role: role as FoundryUserRole };
        assert.equal(hasCombatCopyPermission(subject, 'ACTOR_CREATE', 13, { ACTOR_CREATE: false },
            { ACTOR_CREATE: [3, 4] }), false, 'v13 explicit revocation precedes role membership');
        for (const permission of ['ACTOR_CREATE', 'FILES_BROWSE'] as const) {
            assert.equal(hasCombatCopyPermission(subject, permission, 14, { [permission]: false }, {}),
                role >= 3, 'v14 requires these permissions for Assistant and GM');
            assert.equal(hasCombatCopyPermission(subject, permission, 13, {}, { [permission]: [3, 4] }), role >= 3);
            assert.equal(hasCombatCopyPermission(subject, permission, 13, {}, undefined), false);
        }
        assert.equal(canReadCombatActorPack(subject, 13, { PLAYER: 'NONE', ASSISTANT: 'NONE' }, undefined), role >= 3);
        assert.equal(canReadCombatActorPack(subject, 14, { PLAYER: 'NONE', ASSISTANT: 'NONE' }, undefined), role === 4);
        assert.equal(canReadCombatActorPack(subject, 14, undefined, undefined), role > 0);
        assert.equal(canReadCombatActorPack(subject, 14, { PLAYER: 'OBSERVER', ASSISTANT: 'OWNER' },
            { PLAYER: 'NONE', ASSISTANT: 'NONE' }), role === 4, 'live configuration overrides manifest ownership');
    }
    const assistant = { userId: 'a', role: FoundryUserRole.ASSISTANT };
    assert.equal(canReadCombatActorPack(assistant, 14, { PLAYER: 'OBSERVER', ASSISTANT: 'NONE' }, undefined), true,
        'native pack ownership takes the maximum across inherited roles');
    assert.equal(canReadCombatActorPack(assistant, 14, { PLAYER: 'bad', ASSISTANT: 'bad' }, undefined), false);
    assert.equal(canReadCombatActorPack(assistant, undefined, undefined, undefined), false);
}

if (import.meta.url === `file://${process.argv[1]}`) { run(); console.log('native-combat-permissions.test.ts passed'); }
