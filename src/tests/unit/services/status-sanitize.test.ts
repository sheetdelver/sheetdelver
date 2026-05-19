import { strict as assert } from 'node:assert';
import { sanitizeStatusUser } from '@server/services/status/StatusService';

function runStatusSanitizeTests() {
    const client = {
        resolveUrl: (value?: string) => `resolved:${value || ''}`,
    };

    const userWithAvatar = {
        _id: 'u1',
        name: 'GM User',
        role: 3,
        active: true,
        color: '#fff',
        character: 'char-1',
        avatar: '/avatar.png',
    };

    const sanitizedAvatar = sanitizeStatusUser(userWithAvatar, client as any);
    assert.equal(sanitizedAvatar._id, 'u1');
    assert.equal(sanitizedAvatar.isGM, true);
    assert.equal(sanitizedAvatar.img, 'resolved:/avatar.png');

    const userWithImgFallback = {
        id: 'u2',
        name: 'Player User',
        role: 1,
        active: false,
        color: '#000',
        character: null,
        img: '/img.png',
    };

    const sanitizedImg = sanitizeStatusUser(userWithImgFallback, client as any);
    assert.equal(sanitizedImg._id, 'u2');
    assert.equal(sanitizedImg.isGM, false);
    assert.equal(sanitizedImg.img, 'resolved:/img.png');

    const userMissingRole = {
        id: 'u3',
        name: 'No Role User',
    };

    const sanitizedNoRole = sanitizeStatusUser(userMissingRole, client as any);
    assert.equal(sanitizedNoRole.isGM, false);
}

export function run() {
    runStatusSanitizeTests();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
    console.log('status-sanitize.test.ts passed');
}
