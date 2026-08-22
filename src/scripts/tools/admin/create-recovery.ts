import { logger } from '../../../shared/utils/logger';
import { initDataDir, resolveDataDir } from '../../../server/core/paths';
import { loadAdminAccount } from '../../../server/security/adminCredentialStore';
import { issueAdminRecoveryCredential } from '../../../server/security/adminOneTimeCredentialStore';

async function main(): Promise<void> {
    initDataDir(resolveDataDir(process.argv));
    if (!await loadAdminAccount()) {
        throw new Error('Admin account does not exist; use the bootstrap flow instead.');
    }
    const issued = issueAdminRecoveryCredential();
    logger.info('Single-use admin recovery nonce (valid for 10 minutes):');
    logger.info(issued.token);
    logger.info(`Expires at: ${new Date(issued.expiresAt).toISOString()}`);
}

void main().catch((error) => {
    logger.error('Failed to create admin recovery nonce:', error);
    process.exit(1);
});
