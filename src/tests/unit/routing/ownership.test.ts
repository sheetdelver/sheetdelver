import { strict as assert } from 'node:assert';
import {
    DocumentOwnershipLevel,
    FoundryUserRole,
    createDocumentAccessSubject,
    getEffectiveOwnership,
    isAssistantGM,
    isGM,
    type DocumentAccessSubject,
} from '@server/core/documents/primary/base/ownership';

function subject(role: FoundryUserRole): DocumentAccessSubject {
    return { userId: 'u-1', role };
}

export async function run() {
    runIsGmBoundary();
    runIsAssistantGmBoundary();
    runIsGmIsStricterThanIsAssistantGm();
    runCreateDocumentAccessSubjectNullable();
    runGetEffectiveOwnershipUsesIsGm();
    console.log('  - Ownership helpers: all checks passed');
}

function runIsGmBoundary() {
    // isGM is strict GAMEMASTER (>= 4) — ASSISTANT does NOT pass.
    assert.equal(isGM(subject(FoundryUserRole.NONE)), false, 'NONE is not GM');
    assert.equal(isGM(subject(FoundryUserRole.PLAYER)), false, 'PLAYER is not GM');
    assert.equal(isGM(subject(FoundryUserRole.TRUSTED)), false, 'TRUSTED is not GM');
    assert.equal(isGM(subject(FoundryUserRole.ASSISTANT)), false, 'ASSISTANT is NOT GM (strict)');
    assert.equal(isGM(subject(FoundryUserRole.GAMEMASTER)), true, 'GAMEMASTER is GM');
}

function runIsAssistantGmBoundary() {
    // isAssistantGM is the wider gate (>= ASSISTANT) — used by service-layer
    // permission elevation where Foundry treats ASSISTANT as GM-equivalent.
    assert.equal(isAssistantGM(subject(FoundryUserRole.NONE)), false, 'NONE is not ASSISTANT-GM');
    assert.equal(isAssistantGM(subject(FoundryUserRole.PLAYER)), false, 'PLAYER is not ASSISTANT-GM');
    assert.equal(isAssistantGM(subject(FoundryUserRole.TRUSTED)), false, 'TRUSTED is not ASSISTANT-GM');
    assert.equal(isAssistantGM(subject(FoundryUserRole.ASSISTANT)), true, 'ASSISTANT is ASSISTANT-GM');
    assert.equal(isAssistantGM(subject(FoundryUserRole.GAMEMASTER)), true, 'GAMEMASTER is ASSISTANT-GM');
}

function runIsGmIsStricterThanIsAssistantGm() {
    // The whole point of the distinction: ASSISTANT-GM has elevated service-
    // layer privileges (chat unmask, journal world-list, turn advancement)
    // but does NOT get the implicit OWNER short-circuit on resolveOwnership.
    const assistant = subject(FoundryUserRole.ASSISTANT);
    assert.equal(isAssistantGM(assistant), true);
    assert.equal(isGM(assistant), false);
}

function runCreateDocumentAccessSubjectNullable() {
    // The null return is load-bearing: it's how AppSocketGateway detects
    // anonymous / unauthenticated callers at fan-out time.
    assert.equal(createDocumentAccessSubject(null, FoundryUserRole.GAMEMASTER), null);
    assert.equal(createDocumentAccessSubject(undefined, FoundryUserRole.GAMEMASTER), null);
    assert.equal(createDocumentAccessSubject('', FoundryUserRole.GAMEMASTER), null);

    // Non-empty userId always yields a subject; missing role coerces to NONE.
    const u = createDocumentAccessSubject('u-1', FoundryUserRole.PLAYER);
    assert.ok(u);
    assert.equal(u.userId, 'u-1');
    assert.equal(u.role, FoundryUserRole.PLAYER);

    const noRole = createDocumentAccessSubject('u-2', null);
    assert.ok(noRole);
    assert.equal(noRole.role, FoundryUserRole.NONE);
}

function runGetEffectiveOwnershipUsesIsGm() {
    // GAMEMASTER short-circuits to OWNER regardless of the ownership map.
    assert.equal(
        getEffectiveOwnership({ default: DocumentOwnershipLevel.NONE }, subject(FoundryUserRole.GAMEMASTER)),
        DocumentOwnershipLevel.OWNER,
    );
    // ASSISTANT does NOT short-circuit — they read the map like any other user.
    assert.equal(
        getEffectiveOwnership({ default: DocumentOwnershipLevel.NONE }, subject(FoundryUserRole.ASSISTANT)),
        DocumentOwnershipLevel.NONE,
    );
    assert.equal(
        getEffectiveOwnership({ default: DocumentOwnershipLevel.OBSERVER }, subject(FoundryUserRole.ASSISTANT)),
        DocumentOwnershipLevel.OBSERVER,
    );
    // Explicit user-level entry beats the default.
    assert.equal(
        getEffectiveOwnership(
            { default: DocumentOwnershipLevel.NONE, 'u-1': DocumentOwnershipLevel.OWNER },
            subject(FoundryUserRole.PLAYER),
        ),
        DocumentOwnershipLevel.OWNER,
    );
    // INHERIT with no resolver falls through to NONE for non-GM subjects.
    assert.equal(
        getEffectiveOwnership({ default: DocumentOwnershipLevel.INHERIT }, subject(FoundryUserRole.PLAYER)),
        DocumentOwnershipLevel.NONE,
    );
    // INHERIT with a resolver uses it.
    assert.equal(
        getEffectiveOwnership(
            { default: DocumentOwnershipLevel.INHERIT },
            subject(FoundryUserRole.PLAYER),
            () => DocumentOwnershipLevel.OBSERVER,
        ),
        DocumentOwnershipLevel.OBSERVER,
    );
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('ownership.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
