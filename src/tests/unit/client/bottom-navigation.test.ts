import assert from 'node:assert/strict';
import { createBottomNavigationRegistry } from '../../../client/ui/sdk/bottomNavigation';

export function run() {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
    const listeners = new Set<() => void>();
    const observers: Array<{ callback: () => void; disconnected: boolean }> = [];
    const viewport = { innerHeight: 800, addEventListener: (_: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) };
    class Observer {
        disconnected = false;
        constructor(public callback: () => void) { observers.push(this); }
        observe() {}
        disconnect() { this.disconnected = true; }
    }
    Object.defineProperty(globalThis, 'window', { configurable: true, value: viewport });
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: Observer });
    const bar = (height: number) => ({ isConnected: true, visible: true, height, bottom: 800,
        getBoundingClientRect() { return { height: this.height, bottom: this.bottom }; },
        getClientRects() { return this.visible ? [{}] : []; } });
    try {
        let inset = 0;
        const registry = createBottomNavigationRegistry(height => { inset = height; });
        const small = bar(60), large = bar(90);
        const releaseSmall = registry.register(small as unknown as HTMLElement);
        assert.equal(inset, 60);
        const releaseLarge = registry.register(large as unknown as HTMLElement);
        assert.equal(inset, 90, 'overlapping reservations use the maximum, not the sum');
        large.visible = false;
        observers[1].callback();
        assert.equal(inset, 60, 'responsive hidden bars reserve no space');
        small.height = 70;
        observers[0].callback();
        assert.equal(inset, 70);
        small.bottom = 700;
        listeners.forEach(fn => fn());
        assert.equal(inset, 0, 'only a viewport-bottom bar qualifies');
        small.bottom = 800;
        listeners.forEach(fn => fn());
        assert.equal(inset, 70);
        small.isConnected = false;
        observers[0].callback();
        assert.equal(inset, 0);
        small.isConnected = true;
        observers[0].callback();
        releaseSmall();
        releaseSmall();
        assert.equal(inset, 0, 'release is idempotent');
        assert.ok(observers[0].disconnected);
        large.visible = true;
        observers[1].callback();
        assert.equal(inset, 90);
        registry.clear();
        assert.equal(inset, 0);
        assert.equal(listeners.size, 0);
        assert.ok(observers.every(observer => observer.disconnected));
        observers.forEach(observer => observer.callback());
        releaseLarge();
        assert.equal(inset, 0, 'retired observer callbacks cannot restore a reservation');
        const releaseNext = registry.register(bar(80) as unknown as HTMLElement);
        assert.equal(inset, 80, 'a new scope can register after retirement');
        releaseNext();
        assert.equal(inset, 0);
    } finally {
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
        else Reflect.deleteProperty(globalThis, 'window');
        if (previousObserver) Object.defineProperty(globalThis, 'ResizeObserver', previousObserver);
        else Reflect.deleteProperty(globalThis, 'ResizeObserver');
    }
}
