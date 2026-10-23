interface BodyScrollLock {
    owners: number;
    overflow: string;
    priority: string;
}

const locks = new WeakMap<HTMLElement, BodyScrollLock>();

/** Nested dialogs may retire in any order. Only the final owner restores the original style. */
export function acquireBodyScrollLock(body: HTMLElement = document.body): () => void {
    const lock = locks.get(body) ?? {
        owners: 0,
        overflow: body.style.overflow,
        priority: body.style.getPropertyPriority('overflow'),
    };
    locks.set(body, lock);
    lock.owners++;
    body.style.setProperty('overflow', 'hidden');
    let released = false;
    return () => {
        if (released) return;
        released = true;
        if (--lock.owners > 0) return;
        body.style.setProperty('overflow', lock.overflow, lock.priority);
        locks.delete(body);
    };
}
