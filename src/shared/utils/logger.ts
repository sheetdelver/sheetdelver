// Log Levels matching settings.yaml
// 0=None, 1=Error, 2=Warn, 3=Info, 4=Debug
export const LOG_LEVEL = {
    NONE: 0,
    ERROR: 1,
    WARN: 2,
    INFO: 3,
    DEBUG: 4
} as const;

export type LogLevel = typeof LOG_LEVEL[keyof typeof LOG_LEVEL];

/** A missing or malformed file threshold defaults to INFO. */
export function normalizeFileLogLevel(value: unknown): number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 4
        ? value
        : LOG_LEVEL.INFO;
}

class UniversalLogger {
    private level: number = LOG_LEVEL.INFO; // Default to INFO
    private fileSink: ((level: LogLevel, message: string, args: unknown[]) => void) | null = null;

    /**
     * Update the log level at runtime.
     * On Server: Call this after config is loaded.
     * On Client: Call this after fetching the sanitized config proxy.
     */
    setLevel(level: number) {
        this.level = level;
    }

    /** Configured only by server entry points; browser logging remains console-only. */
    setFileSink(sink: ((level: LogLevel, message: string, args: unknown[]) => void) | null) {
        this.fileSink = sink;
    }

    private write(level: LogLevel, label: string, method: 'error' | 'warn' | 'info' | 'debug', message: string, args: unknown[]) {
        if (this.level >= level) console[method](`[${label}]`, message, ...args);
        this.fileSink?.(level, message, args);
    }

    error(message: string, ...args: any[]) {
        this.write(LOG_LEVEL.ERROR, 'ERROR', 'error', message, args);
    }

    warn(message: string, ...args: any[]) {
        this.write(LOG_LEVEL.WARN, 'WARN', 'warn', message, args);
    }

    info(message: string, ...args: any[]) {
        this.write(LOG_LEVEL.INFO, 'INFO', 'info', message, args);
    }

    debug(message: string, ...args: any[]) {
        this.write(LOG_LEVEL.DEBUG, 'DEBUG', 'debug', message, args);
    }

    time(label: string) {
        if (this.level >= LOG_LEVEL.DEBUG) {
            console.time(label);
        }
    }

    timeEnd(label: string) {
        if (this.level >= LOG_LEVEL.DEBUG) {
            console.timeEnd(label);
        }
    }
}

export const logger = new UniversalLogger();
