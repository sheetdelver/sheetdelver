import { strict as assert } from 'node:assert';
import { projectPublicStatus, sanitizeStatusUser } from '@server/services/status/StatusService';
import type { SystemStatusPayload } from '@shared/contracts/status';

function runStatusSanitizeTests() {
    const foundryBaseUrl = 'http://foundry.test/';

    const userWithAvatar = {
        _id: 'u1',
        name: 'GM User',
        role: 3,
        active: true,
        color: '#fff',
        character: 'char-1',
        avatar: '/avatar.png',
    };

    const sanitizedAvatar = sanitizeStatusUser(userWithAvatar, foundryBaseUrl);
    assert.equal(sanitizedAvatar._id, 'u1');
    assert.equal(sanitizedAvatar.isGM, true);
    assert.equal(sanitizedAvatar.img, 'http://foundry.test/avatar.png');

    const userWithImgFallback = {
        id: 'u2',
        name: 'Player User',
        role: 1,
        active: false,
        color: '#000',
        character: null,
        img: '/img.png',
    };

    const sanitizedImg = sanitizeStatusUser(userWithImgFallback, foundryBaseUrl);
    assert.equal(sanitizedImg._id, 'u2');
    assert.equal(sanitizedImg.isGM, false);
    assert.equal(sanitizedImg.img, 'http://foundry.test/img.png');

    const userMissingRole = {
        id: 'u3',
        name: 'No Role User',
    };

    const sanitizedNoRole = sanitizeStatusUser(userMissingRole, foundryBaseUrl);
    assert.equal(sanitizedNoRole.isGM, false);

    const publicStatus = projectPublicStatus({
        connected: true,
        worldId: 'secret-world-id',
        initialized: true,
        isConfigured: true,
        foundryCompatibility: null,
        users: [sanitizedAvatar, sanitizedImg],
        system: {
            id: 'shadowdark',
            title: 'Shadowdark RPG',
            version: '4.0.6',
            worldTitle: 'Public World Title',
            worldDescription: '<p>Public campaign introduction</p>',
            worldBackground: 'http://foundry.test/world-background.png',
            background: 'http://foundry.test/system-background.png',
            nextSession: 'Saturday at 7 PM',
            theme: { bg: 'bg-black', accent: 'text-red-500' },
            componentStyles: { loadingModal: { container: 'bg-black' } },
            actorSyncToken: 'private-sync-token',
            status: 'active',
            users: { active: 1, total: 2 },
            config: { privateConfigMarker: true },
            internalMetadata: 'private-internal-metadata',
        },
        url: foundryBaseUrl,
        appVersion: 'test',
        debug: { enabled: true, level: 4 },
    } as SystemStatusPayload);

    assert.deepEqual(publicStatus.users, [
        { name: 'GM User', active: true, canLogin: false },
        { name: 'Player User', active: false, canLogin: true },
    ]);
    assert.deepEqual(publicStatus.system, {
        id: 'shadowdark',
        title: 'Shadowdark RPG',
        version: '4.0.6',
        worldTitle: 'Public World Title',
        worldDescription: '<p>Public campaign introduction</p>',
        worldBackground: 'http://foundry.test/world-background.png',
        background: 'http://foundry.test/system-background.png',
        nextSession: 'Saturday at 7 PM',
        status: 'active',
        users: { active: 1, total: 2 },
        theme: { bg: 'bg-black', accent: 'text-red-500' },
        componentStyles: { loadingModal: { container: 'bg-black' } },
    });
    for (const privateKey of ['worldId', 'url', 'debug']) {
        assert.equal(Object.hasOwn(publicStatus, privateKey), false, `${privateKey} must not enter the public projection`);
    }
    const serializedPublicStatus = JSON.stringify(publicStatus);
    for (const privateValue of ['private-sync-token', 'privateConfigMarker', 'private-internal-metadata']) {
        assert.equal(serializedPublicStatus.includes(privateValue), false, `${privateValue} must remain private`);
    }
}

export function run() {
    runStatusSanitizeTests();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
    console.log('status-sanitize.test.ts passed');
}
