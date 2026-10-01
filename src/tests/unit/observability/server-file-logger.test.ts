import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ServerFileLogger } from '@server/observability/ServerFileLogger';
import { LOG_LEVEL, logger } from '@shared/utils/logger';

export function run(): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sheetdelver-file-log-'));
    try {
        const directory = path.join(root, 'logs');
        const sink = new ServerFileLogger('core', 3, directory);
        logger.setFileSink(sink.write);
        logger.setLevel(1);
        logger.info('World entered setup (reason=%s).', 'heartbeat');
        logger.warn('Purged %d sessions.', 2);
        logger.debug('Hidden debug message.');
        const filePath = path.join(directory, 'sheetdelver-core.log');
        assert.match(fs.readFileSync(filePath, 'utf8'),
            /^\[\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\] \[INFO\] World entered setup \(reason=heartbeat\)\.\n\[\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\] \[WARN\] Purged 2 sessions\.\n$/);
        if (process.platform !== 'win32') {
            assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
            assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
        }

        // Reopen per write, so an external rotator can rename the old file.
        fs.renameSync(filePath, path.join(directory, 'sheetdelver-core.log.1'));
        sink.write(LOG_LEVEL.ERROR, 'After external rotation.', []);
        assert.match(fs.readFileSync(filePath, 'utf8'),
            /^\[\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\] \[ERROR\] After external rotation\.\n$/);

        const disabled = new ServerFileLogger('manager', 0, directory);
        disabled.write(LOG_LEVEL.ERROR, 'Should not persist.', []);
        assert.equal(fs.existsSync(path.join(directory, 'sheetdelver-manager.log')), false);

        const originalConsoleInfo = console.info;
        const consoleArgs: unknown[][] = [];
        console.info = (...args: unknown[]) => { consoleArgs.push(args); };
        try {
            logger.setLevel(3);
            logger.info('Console plain.');
        } finally {
            console.info = originalConsoleInfo;
        }
        assert.deepEqual(consoleArgs, [['[INFO]', 'Console plain.']]);

        const linkedDirectory = path.join(root, 'linked-logs');
        fs.mkdirSync(linkedDirectory);
        const target = path.join(root, 'target.log');
        fs.writeFileSync(target, 'untouched');
        fs.symlinkSync(target, path.join(linkedDirectory, 'sheetdelver-core.log'));
        const originalConsoleError = console.error;
        console.error = () => undefined;
        try {
            new ServerFileLogger('core', 3, linkedDirectory).write(LOG_LEVEL.INFO, 'No follow.', []);
        } finally {
            console.error = originalConsoleError;
        }
        assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
    } finally {
        logger.setFileSink(null);
        logger.setLevel(3);
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log('server-file-logger.test.ts passed');
}
