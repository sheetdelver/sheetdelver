import { ClientSocket } from '@core/foundry/sockets/ClientSocket';
import { CoreSocket } from '@core/foundry/sockets/CoreSocket';
import { loadConfig } from '@core/config';
import 'dotenv/config';
import { logger } from '@shared/utils/logger';
import { folderStore } from '@server/core/documents/primary/folders/FolderStore';
import { journalStore } from '@server/core/documents/primary/journals/JournalStore';
import { userStore } from '@server/core/documents/primary/users/UserStore';

// Force test env (Ignore read-only error for test script)
// @ts-ignore
process.env.NODE_ENV = 'test';

async function testJournals() {
    logger.info('🧪 Test 6: Journals Endpoint Verification');

    const config = await loadConfig();
    if (!config) {
        logger.error('❌ Could not load config');
        process.exit(1);
    }

    // Initialize Stack
    const core = new CoreSocket(config.foundry);
    const client = new ClientSocket(config.foundry, core);

    try {
        logger.info('📡 Connecting...');
        // Connect Core Socket (Actual connection)
        await core.connect();

        // ClientSocket doesn't need explicit connect, but we might want to ensure it's "ready"

        // Login as player (doratheexplorer) to test permissions
        // or GM? Let's use the config default (which was doratheexplorer in previous tests)
        logger.info(`👤 Identifying as: ${(client as any).config.username}`);

        // 1. List (Store-backed)
        logger.info('📚 Fetching Journals...');
        await journalStore.seed(async () => {
            const response = await core.dispatchDocumentSocket('JournalEntry', 'get', { broadcast: false });
            return response?.result || [];
        });
        const journals = journalStore.list();
        logger.info(`✅ Fetched ${journals.length} Journal Entries`);

        logger.info('📁 Fetching Folders...');
        await folderStore.seed(async () => {
            const response = await core.dispatchDocumentSocket('Folder', 'get', { broadcast: false });
            return response?.result || [];
        });
        const folders = folderStore.listByType('JournalEntry');
        logger.info(`✅ Fetched ${folders.length} Journal Folders`);

        logger.info('👥 Fetching Users...');
        const users = userStore.listWithPresence();
        logger.info(`✅ Fetched ${users.length} Users`);

        // 2. Create Journal
        logger.info('📝 Creating Test Journal...');
        const createResult = await core.dispatchDocumentSocket('JournalEntry', 'create', {
            data: [{ name: 'Test Journal from Script', folder: null }],
            broadcast: true
        });
        const newJournal = createResult?.result?.[0];
        if (!newJournal) throw new Error('Failed to create journal');
        logger.info(`✅ Created: ${newJournal.name} (${newJournal._id})`);

        // 3. Update Journal
        logger.info('✍️ Updating Test Journal...');
        const updateResult = await core.dispatchDocumentSocket('JournalEntry', 'update', {
            updates: [{ _id: newJournal._id, name: 'Test Journal Updated' }],
            broadcast: true
        });
        const updatedJournal = updateResult?.result?.[0];
        logger.info(`✅ Updated: ${updatedJournal?.name}`);

        // 4. Create Folder
        logger.info('📂 Creating Test Folder...');
        const folderResult = await core.dispatchDocumentSocket('Folder', 'create', {
            data: [{ name: 'Test Test Folder', type: 'JournalEntry', parent: null }],
            broadcast: true
        });
        const newFolder = folderResult?.result?.[0];
        if (!newFolder) throw new Error('Failed to create folder');
        logger.info(`✅ Created Folder: ${newFolder.name} (${newFolder._id})`);

        // 5. Delete Journal
        logger.info('🗑️ Deleting Test Journal...');
        await core.dispatchDocumentSocket('JournalEntry', 'delete', {
            ids: [newJournal._id],
            broadcast: true
        });
        logger.info('✅ Deleted Journal');

        // 6. Delete Folder
        logger.info('🗑️ Deleting Test Folder...');
        await core.dispatchDocumentSocket('Folder', 'delete', {
            ids: [newFolder._id],
            broadcast: true
        });
        logger.info('✅ Deleted Folder');

        client.disconnect();
        core.disconnect();
        process.exit(0);

    } catch (e) {
        logger.error('❌ Test Failed:', e);
        client.disconnect();
        core.disconnect();
        process.exit(1);
    }
}

testJournals();
