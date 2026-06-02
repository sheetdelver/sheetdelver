/**
 * Capability detection (ADR-0027 decision 23).
 *
 * `capabilities.supports('combat' | 'effects' | 'tables' | …)` lets a module gate optional
 * surfaces on what this SDK build provides, alongside `SDK_VERSION` / `API_CONTRACT_VERSIONS`.
 * It reports the platform features the SDK exposes — not per-world/system availability.
 */

/** Capabilities this SDK build provides. */
export const SDK_CAPABILITIES = [
    'documents',   // useDocument / useDocumentMutation + runtime.documents
    'rolls',       // runtime.rolls
    'tables',      // runtime.tables (RollTable draw)
    'compendium',  // runtime.compendium
    'effects',     // embedded ActiveEffect mutations
    'combat',      // Combat is a primary document (document:changed { type: 'Combat' })
    'settings',    // useModuleSettings
    'assets',      // assetUrl()
    'events',      // SDK.events signal bus
] as const;

export type SdkCapability = typeof SDK_CAPABILITIES[number];

const SUPPORTED: ReadonlySet<string> = new Set(SDK_CAPABILITIES);

export const capabilities = {
    /** Whether this SDK build supports the given capability. */
    supports(capability: SdkCapability | string): boolean {
        return SUPPORTED.has(capability);
    },
    /** The full list of supported capabilities. */
    list(): readonly SdkCapability[] {
        return SDK_CAPABILITIES;
    },
};
