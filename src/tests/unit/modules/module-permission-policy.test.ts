import { strict as assert } from 'node:assert';
import { evaluatePermissionDelta, normalizePermissions } from '@modules/registry/permissionPolicy';

export function run() {
    const normalized = normalizePermissions();
    assert.equal(normalized.network.outbound, false);
    assert.deepEqual(normalized.network.allowHosts, []);
    assert.deepEqual(normalized.filesystem.read, []);
    assert.deepEqual(normalized.filesystem.write, []);
    assert.equal(normalized.adminRoutes, false);
    assert.deepEqual(normalized.sensitiveData, []);

    const noEscalation = evaluatePermissionDelta(
        {
            network: { outbound: true, allowHosts: ['api.example.com'] },
            filesystem: { read: ['moduleData'] },
            adminRoutes: false,
            sensitiveData: ['actor'],
        },
        {
            network: { outbound: true, allowHosts: ['api.example.com'] },
            filesystem: { read: ['moduleData'] },
            adminRoutes: false,
            sensitiveData: ['actor'],
        }
    );
    assert.equal(noEscalation.escalated, false);
    assert.deepEqual(noEscalation.escalations, []);

    const escalation = evaluatePermissionDelta(
        {
            network: { outbound: false, allowHosts: ['api.example.com'] },
            filesystem: { read: ['moduleData'] },
            adminRoutes: false,
            sensitiveData: ['actor'],
        },
        {
            network: { outbound: true, allowHosts: ['api.example.com', 'cdn.example.com'] },
            filesystem: { read: ['moduleData', 'worldData'], write: ['moduleData'] },
            adminRoutes: true,
            sensitiveData: ['actor', 'chat'],
        }
    );
    assert.equal(escalation.escalated, true);
    assert.equal(escalation.escalations.some((item) => item.key === 'network.outbound'), true);
    assert.equal(escalation.escalations.some((item) => item.key === 'network.allowHosts'), true);
    assert.equal(escalation.escalations.some((item) => item.key === 'filesystem.read'), true);
    assert.equal(escalation.escalations.some((item) => item.key === 'filesystem.write'), true);
    assert.equal(escalation.escalations.some((item) => item.key === 'adminRoutes'), true);
    assert.equal(escalation.escalations.some((item) => item.key === 'sensitiveData'), true);

    console.log('module-permission-policy: PASS');
}
