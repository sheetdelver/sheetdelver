import { strict as assert } from 'node:assert';
import { verifyArtifactMetadata } from '@modules/registry/artifactVerification';

export function run() {
    const now = 123456;

    const local = verifyArtifactMetadata({
        moduleId: 'shadowdark',
        operation: 'install',
        source: 'local://shadowdark',
        integrity: undefined,
        signature: undefined,
        now,
    });
    assert.equal(local.verified, true);
    assert.equal(local.status, 'skipped');

    const missingIntegrity = verifyArtifactMetadata({
        moduleId: 'shadowdark',
        operation: 'install',
        source: 'https://example.com/module.tgz',
        now,
    });
    assert.equal(missingIntegrity.verified, false);
    assert.equal(missingIntegrity.status, 'failed');
    assert.equal(missingIntegrity.reason?.includes('integrity is required'), true);

    const missingSignature = verifyArtifactMetadata({
        moduleId: 'shadowdark',
        operation: 'upgrade',
        source: 'https://example.com/module.tgz',
        integrity: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        now,
    });
    assert.equal(missingSignature.verified, false);
    assert.equal(missingSignature.status, 'failed');
    assert.equal(missingSignature.reason?.includes('signature is required'), true);

    const validRawDigest = verifyArtifactMetadata({
        moduleId: 'shadowdark',
        operation: 'upgrade',
        source: 'https://example.com/module.tgz',
        integrity: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        signature: 'minisign:abc123',
        now,
    });
    assert.equal(validRawDigest.verified, true);
    assert.equal(validRawDigest.status, 'verified');
    assert.equal(
        validRawDigest.integrity,
        'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    );

    console.log('module-artifact-verification: PASS');
}
