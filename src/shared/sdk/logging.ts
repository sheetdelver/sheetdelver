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
