import fs from 'node:fs';
import path from 'node:path';
import { formatWithOptions } from 'node:util';
import { LOG_LEVEL, logger, normalizeFileLogLevel, type LogLevel } from '../../shared/utils/logger';
import {
    ensureOwnerOnlyDirectorySync,
    ensureOwnerOnlyFileSync,
    getLogsDir,
    OWNER_ONLY_FILE_MODE,
} from '../core/paths';

type Source = 'manager' | 'core';

const LABELS: Record<number, string> = {
    [LOG_LEVEL.ERROR]: 'ERROR',
    [LOG_LEVEL.WARN]: 'WARN',
    [LOG_LEVEL.INFO]: 'INFO',
    [LOG_LEVEL.DEBUG]: 'DEBUG',
};

/** Plain-text append sink. The service manager or logrotate owns rotation. */
export class ServerFileLogger {
    private readonly filePath: string;
    private readonly level: number;
    private lastWarningAt = -Infinity;

    constructor(source: Source, fileLevel: number, directory = getLogsDir()) {
        this.filePath = path.join(directory, `sheetdelver-${source}.log`);
        this.level = normalizeFileLogLevel(fileLevel);
    }

    write = (level: LogLevel, message: string, args: unknown[]): void => {
        if (level > this.level || this.level === LOG_LEVEL.NONE) return;
        try {
            ensureOwnerOnlyDirectorySync(path.dirname(this.filePath));
            ensureOwnerOnlyFileSync(this.filePath);
            const line = `[${new Date().toISOString()}] [${LABELS[level]}] ${formatWithOptions({ colors: false }, message, ...args).replace(/\x1b\[[0-9;]*m/g, '')}\n`;
            const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND
                | (fs.constants.O_NOFOLLOW ?? 0);
            const descriptor = fs.openSync(this.filePath, flags, OWNER_ONLY_FILE_MODE);
            try {
                fs.writeFileSync(descriptor, line, 'utf8');
            } finally {
                fs.closeSync(descriptor);
            }
            ensureOwnerOnlyFileSync(this.filePath);
        } catch {
            // Logging must never break application behavior or recurse through logger.
            const now = Date.now();
            if (now - this.lastWarningAt < 60_000) return;
            this.lastWarningAt = now;
            console.error('[FileLogger] Log write failed; file output may be incomplete.');
        }
    };
}

export function configureServerFileLogging(source: Source, fileLevel: number): void {
    logger.setFileSink(new ServerFileLogger(source, fileLevel).write);
}
