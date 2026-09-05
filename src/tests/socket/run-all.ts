#!/usr/bin/env tsx
/**
 * Socket Test Runner
 * Runs all socket tests in sequence and reports results
 */

import { testConnection } from './01-connection.test';
import { testSystemInfo } from './02-system-info.test';
import { testActorAccess } from './03-actor-access.test';
import { testUsersAndCompendia } from './04-users-compendia.test';
import { testWriteOperations } from './05-write-operations.test';
import { testRolling } from './09-rolling.test';
import { testBatchOperations } from './10-batch-operations.test';
import { logger } from '@shared/utils/logger';
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

interface SocketTestCase {
    file: string;
    name: string;
    fn: () => Promise<{ success?: boolean; error?: string }>;
}

function assertSocketRunnerCoversRootTestFiles(tests: SocketTestCase[]) {
    const socketTestDir = dirname(fileURLToPath(import.meta.url));
    const rootTestFiles = readdirSync(socketTestDir)
        .filter((entry) => entry.endsWith('.test.ts'))
        .sort();
    const registeredFiles = tests.map((test) => test.file).sort();
    const missing = rootTestFiles.filter((file) => !registeredFiles.includes(file));
    const stale = registeredFiles.filter((file) => !rootTestFiles.includes(file));

    if (missing.length || stale.length) {
        throw new Error([
            'Socket runner drift detected.',
            missing.length ? `Missing from runner: ${missing.join(', ')}` : '',
            stale.length ? `Registered but not present: ${stale.join(', ')}` : '',
            'Move exploratory/manual scripts into src/tests/socket/manual/*.manual.ts, or register automated tests here.',
        ].filter(Boolean).join(' '));
    }
}

async function runAllTests() {
    logger.info('🚀 Socket Client Test Suite\n');
    logger.info('='.repeat(60));

    const tests: SocketTestCase[] = [
        { file: '01-connection.test.ts', name: 'Connection & Authentication', fn: testConnection },
        { file: '02-system-info.test.ts', name: 'System Information', fn: testSystemInfo },
        { file: '03-actor-access.test.ts', name: 'Actor Data Access', fn: testActorAccess },
        { file: '04-users-compendia.test.ts', name: 'Users & Compendium Data', fn: testUsersAndCompendia },
        { file: '05-write-operations.test.ts', name: 'Write Operations', fn: testWriteOperations },
        { file: '09-rolling.test.ts', name: 'Rolling Operations', fn: testRolling },
        { file: '10-batch-operations.test.ts', name: 'Batch Operations', fn: testBatchOperations },
    ];
    assertSocketRunnerCoversRootTestFiles(tests);

    const results: any[] = [];

    for (const test of tests) {
        logger.info(`\n📋 Running: ${test.name}`);
        logger.info('-'.repeat(60));

        try {
            const result = await test.fn();
            results.push({ name: test.name, ...result });
        } catch (error: any) {
            logger.error(`❌ Test crashed: ${error.message}`);
            results.push({ name: test.name, success: false, error: error.message });
        }

        logger.info('='.repeat(60));
    }

    // Final Summary
    logger.info('\n\n' + '='.repeat(60));
    logger.info('📊 FINAL TEST SUMMARY');
    logger.info('='.repeat(60));

    const passed = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    results.forEach(r => {
        const icon = r.success ? '✅' : '❌';
        logger.info(`${icon} ${r.name}`);
        if (r.error) {
            logger.info(`   Error: ${r.error}`);
        }
    });

    logger.info('\n' + '-'.repeat(60));
    logger.info(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
    logger.info(`Success Rate: ${((passed / results.length) * 100).toFixed(1)}%`);
    logger.info('='.repeat(60) + '\n');

    process.exit(failed > 0 ? 1 : 0);
}

runAllTests().catch(error => {
    logger.error('❌ Test runner crashed:', error);
    process.exit(1);
});
