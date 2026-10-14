'use client';

/** Host-owned reservations; modules supply only their own bottom-bar element. */
export function createBottomNavigationRegistry(onInset: (height: number) => void) {
    const registrations = new Map<symbol, { height: number; stop: () => void }>();
    const publish = () => onInset(Math.max(0, ...Array.from(registrations.values(), item => item.height)));
    return {
        register(element: HTMLElement): () => void {
            const key = Symbol('bottom-navigation');
            const measure = () => {
                const registration = registrations.get(key);
                if (!registration) return;
                const rect = element.getBoundingClientRect();
                const height = element.isConnected && element.getClientRects().length && rect.height > 0
                    && Math.abs(rect.bottom - window.innerHeight) <= 2
                    ? Math.min(window.innerHeight, rect.height) : 0;
                if (registration.height !== height) { registration.height = height; publish(); }
            };
            const observer = new ResizeObserver(measure);
            const stop = () => { observer.disconnect(); window.removeEventListener('resize', measure); };
            registrations.set(key, { height: 0, stop });
            observer.observe(element);
            window.addEventListener('resize', measure);
            measure();
            return () => {
                if (!registrations.delete(key)) return;
                stop();
                publish();
            };
        },
        clear() {
            for (const registration of registrations.values()) registration.stop();
            registrations.clear();
            onInset(0);
        },
    };
}
