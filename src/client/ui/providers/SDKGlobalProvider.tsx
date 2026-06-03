'use client';

/**
 * SDKGlobalProvider
 *
 * Exposes React and the SDK on `window.__SD` at module-evaluation time so that
 * runtime-installed module artifacts (loaded after the Next.js build via a
 * native browser ESM import) can access shared dependencies without an import
 * map or duplicate React instances.
 *
 * The assignment runs synchronously when this chunk is parsed — before any
 * dynamic module imports fire — so the globals are always available when module
 * UI code executes.
 *
 * Module artifacts served by GET /api/modules/:id/ui have their bare ESM
 * import statements rewritten to `window.__SD.*` references server-side, so
 * the browser's native ESM loader can resolve them without bare-specifier support.
 */

import React from 'react';
import * as ReactJSX from 'react/jsx-runtime';
import * as SDKExports from '@sheet-delver/sdk';
import * as SDKReactExports from '@sheet-delver/sdk/react';

// Synchronous assignment — intentionally outside a useEffect so the globals
// are present before any component renders.
if (typeof window !== 'undefined') {
    (window as any).__SD = {
        /** The host application's React instance. Shared so module hooks and
         *  context (useSDK, useSDKComponents) work across the boundary. */
        React,
        /** react/jsx-runtime re-exported from the host bundle. */
        ReactJSX,
        /** Shared @sheet-delver/sdk exports (types/utils). */
        sdk: SDKExports,
        /** Client @sheet-delver/sdk/react exports (hooks, context, components).
         *  The server entry is intentionally NOT exposed — server-only code is
         *  rejected from UI bundles (ADR-0027 decisions 2 / 29). */
        sdkReact: SDKReactExports,
    };
}

export default function SDKGlobalProvider({ children }: { children: React.ReactNode }) {
    return <>{children}</>;
}
