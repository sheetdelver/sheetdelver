import { logger } from '../../../shared/utils/logger';
import { initDataDir, resolveDataDir } from '../../../server/core/paths';
import { loadAdminAccount } from '../../../server/security/adminCredentialStore';
import { issueAdminBootstrapCredential } from '../../../server/security/adminOneTimeCredentialStore';

async function main(): Promise<void> {
    initDataDir(resolveDataDir(process.argv));
    if (await loadAdminAccount()) {
        throw new Error('Admin account already exists; bootstrap credential was not issued.');
    }
    const issued = issueAdminBootstrapCredential();
    logger.info('One-time admin bootstrap credential (valid for 60 minutes):');
    logger.info(issued.token);
    logger.info(`Expires at: ${new Date(issued.expiresAt).toISOString()}`);
}

void main().catch((error) => {
    logger.error('Failed to create admin bootstrap credential:', error);
    process.exit(1);
});
