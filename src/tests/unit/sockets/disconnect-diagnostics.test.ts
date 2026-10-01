import { strict as assert } from 'node:assert';
import { formatDisconnectDiagnostic } from '@server/core/foundry/sockets/disconnectDiagnostics';

export function run(): void {
    const line = formatDisconnectDiagnostic({
        role: 'core', generation: 3, connectedAt: 1000, now: 2500,
        reason: 'transport close', transport: 'websocket',
        details: { message: 'websocket connection closed', description: 1006,
            context: { cookie: 'session=secret' } },
    });
    assert.match(line, /role=core, generation=3, ageMs=1500, transport=websocket, reason=transport close/);
    assert.match(line, /detail=websocket connection closed, description=1006/);
    assert.doesNotMatch(line, /secret|cookie|context/);

    const unsafe = formatDisconnectDiagnostic({
        role: 'player', generation: 1, connectedAt: null, now: 0,
        reason: 'arbitrary token=secret', transport: 'unknown-transport',
        details: { message: 'https://private.example/?session=secret', description: { data: 'secret' } },
    });
    assert.equal(unsafe, 'Foundry socket | role=player, generation=1, ageMs=unknown, transport=unknown, reason=other');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
    console.log('disconnect-diagnostics.test.ts passed');
}
