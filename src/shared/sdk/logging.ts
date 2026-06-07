/**
 * ModuleLogger defines the standardized logging interface provided to modules.
 * This logger is typically namespaced to the module ID by the platform.
 */
export interface ModuleLogger {
    /** Log detailed debugging information. */
    debug(message: string, ...args: unknown[]): void;
    /** Log general operational information. */
    info(message: string, ...args: unknown[]): void;
    /** Log warning conditions that don't stop execution. */
    warn(message: string, ...args: unknown[]): void;
    /** Log error conditions that may require attention. */
    error(message: string, ...args: unknown[]): void;
}

/**
 * The importable SDK logger (ADR-0027 logging addendum).
 *
 * Module code — including pure logic files that never receive a `runtime` — must log
 * through this surface (`logger` / `createModuleLogger`) instead of raw `console.*`;
 * `check-module` fails the build on direct `console.*` use. The sink is late-bound:
 * until the platform binds it, output goes to `console`. The platform rebinds it during
 * module bootstrap (`BaseSystemAdapter.initialize` server-side, the SDK provider
 * client-side) so module logs funnel through the platform logger — module-prefixed and
 * level-controlled — without the author threading a logger through every call site.
 */
const consoleSink: ModuleLogger = {
    debug: (message, ...args) => console.debug(message, ...args),
    info: (message, ...args) => console.info(message, ...args),
    warn: (message, ...args) => console.warn(message, ...args),
    error: (message, ...args) => console.error(message, ...args),
};

let activeSink: ModuleLogger = consoleSink;

/**
 * Bind the underlying sink for this module's SDK logger. Called by the platform during
 * module bootstrap to route module logs through the platform logger. Passing `null`
 * restores the default `console` sink (used by `@sheet-delver/sdk/testing`).
 */
export function setModuleLogSink(sink: ModuleLogger | null): void {
    activeSink = sink ?? consoleSink;
}

/**
 * Create a namespaced logger. The namespace is prefixed to each message, so a logic file
 * can label its output (`createModuleLogger('normalization')`) without a runtime handle.
 * Methods read the active sink lazily, so a logger created at import time still funnels
 * through the platform sink once it is bound.
 */
export function createModuleLogger(namespace?: string): ModuleLogger {
    const tag = namespace ? `[${namespace}] ` : '';
    return {
        debug: (message, ...args) => activeSink.debug(`${tag}${message}`, ...args),
        info: (message, ...args) => activeSink.info(`${tag}${message}`, ...args),
        warn: (message, ...args) => activeSink.warn(`${tag}${message}`, ...args),
        error: (message, ...args) => activeSink.error(`${tag}${message}`, ...args),
    };
}

/** The default, un-namespaced module logger. */
export const logger: ModuleLogger = createModuleLogger();
