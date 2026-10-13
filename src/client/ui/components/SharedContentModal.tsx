
'use client';

import { SharedContentHost } from './SharedContentHost';

export function SharedContentModal() {
    // Compatibility component for SDK consumers. The persistent Core layout
    // now owns the single overlay; mounting another copy is intentionally inert.
    return null;
}

export { SharedContentHost };
