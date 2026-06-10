import { strict as assert } from 'node:assert';
import { redactSourceProfile } from '@modules/registry/distribution/sourceProfiles';
import { ModuleSourceKind } from '@shared/types/modules';
import type { SourceProfile } from '@modules/registry/distribution/sourceProfiles';

function makeProfile(overrides: Partial<SourceProfile> = {}): SourceProfile {
    return {
        id: 'src_test',
        name: 'Test Source',
        kind: ModuleSourceKind.Indexed,
        baseUrl: 'https://registry.example.com',
        enabled: true,
        priority: 10,
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    };
}

async function runSourceProfileRedactionTests(): Promise<void> {
    console.log('Running source-profile redaction tests...');

    // Test 1: bearer token is stripped but auth presence is preserved
    console.log('  Test 1: bearer token stripped, presence preserved');
    const withAuth = makeProfile({ auth: { type: 'bearer', token: 'super-secret-token' } });
    const redacted = withAuth.auth ? redactSourceProfile(withAuth) : null;
    assert.ok(redacted, 'redacted profile should exist');
    assert.equal((redacted as any).auth?.type, 'bearer', 'auth type should be preserved');
    assert.equal((redacted as any).auth?.configured, true, 'auth should be marked configured');
    assert.equal('token' in ((redacted as any).auth ?? {}), false, 'token must not be present in redacted output');
    assert.equal(JSON.stringify(redacted).includes('super-secret-token'), false, 'serialized output must not leak the token');
    // Original is untouched.
    assert.equal(withAuth.auth?.token, 'super-secret-token', 'source object must not be mutated');

    // Test 2: profiles without auth round-trip with no auth field
    console.log('  Test 2: no-auth profile has no auth field');
    const noAuth = redactSourceProfile(makeProfile());
    assert.equal((noAuth as any).auth, undefined, 'profile without auth should have no auth field');
    assert.equal(noAuth.baseUrl, 'https://registry.example.com', 'non-secret fields are preserved');

    console.log('  All source-profile redaction tests passed!');
}

export function run(): Promise<void> {
    return runSourceProfileRedactionTests();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run()
        .then(() => console.log('source-profile-redaction.test.ts passed'))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
