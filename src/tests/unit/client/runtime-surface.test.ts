import { strict as assert } from 'node:assert';
import { assertPlayerSurface } from '@client/hooks/useRuntimeSurface';

function withWindowPath(pathname: string, callback: () => void) {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
            location: { pathname },
        },
    });

    try {
        callback();
    } finally {
        if (originalWindow) {
            Object.defineProperty(globalThis, 'window', originalWindow);
        } else {
            delete (globalThis as { window?: unknown }).window;
        }
    }
}

function captureWarnings(callback: () => void): unknown[][] {
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
        warnings.push(args);
    };

    try {
        callback();
        return warnings;
    } finally {
        console.warn = originalWarn;
    }
}

export function run() {
    const playerWarnings = captureWarnings(() => {
        withWindowPath('/actors/abc123', () => {
            assertPlayerSurface();
        });
    });
    assert.equal(playerWarnings.length, 0);

    const adminWarnings = captureWarnings(() => {
        withWindowPath('/admin', () => {
            assertPlayerSurface();
        });
    });
    assert.equal(adminWarnings.length, 1);
    assert.equal(adminWarnings[0][0], '[WARN]');
    assert.equal(adminWarnings[0][1], '[Player Runtime Guard] Player context accessed on admin surface. This indicates a composition error.');
    assert.deepEqual((adminWarnings[0][2] as { pathname: string }).pathname, '/admin');

    console.log('  - Runtime surface guard: all checks passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
    console.log('runtime-surface.test.ts passed');
}
