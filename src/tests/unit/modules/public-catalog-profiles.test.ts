import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    __resetDataDirForTests,
    getDataDir,
    getModulesDataDir,
    initDataDir,
} from '@core/paths';
import {
    __resetSourceProfilesForTests,
    createSourceProfile,
    deleteSourceProfile,
    loadSourceProfiles,
    OFFICIAL_CATALOG_PROFILE_ID,
    OFFICIAL_CATALOG_URL,
    updateSourceProfile,
} from '@modules/registry/distribution/sourceProfiles';

export function run() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-delver-catalog-profiles-'));
    let previousDataDir: string | null = null;
    try {
        try { previousDataDir = getDataDir(); } catch { /* paths were not initialized */ }
        initDataDir(tempRoot);
        const profilesFile = path.join(getModulesDataDir(), 'sources.json');
        fs.writeFileSync(profilesFile, JSON.stringify([{
            id: 'legacy-custom',
            name: 'Legacy Custom',
            kind: 'indexed',
            baseUrl: 'https://catalog.example/catalog.json',
            enabled: true,
            priority: 200,
            trustTier: 'first-party',
            auth: { type: 'bearer', token: 'must-be-removed' },
            hostAllowlist: ['catalog.example'],
            createdAt: 1,
            updatedAt: 1,
        }, {
            id: OFFICIAL_CATALOG_PROFILE_ID,
            name: 'Sheet Delver Official Catalog',
            kind: 'indexed',
            baseUrl: 'https://sheetdelver.github.io/module-catalog/catalog.json',
            enabled: false,
            priority: 37,
            trustTier: 'first-party',
            createdAt: 1,
            updatedAt: 1,
        }]));
        __resetSourceProfilesForTests();

        const profiles = loadSourceProfiles();
        assert.equal(profiles.some((profile) => profile.id === 'local-default'), true);
        assert.equal(profiles.some((profile) => profile.id === OFFICIAL_CATALOG_PROFILE_ID), true);
        const official = profiles.find((profile) => profile.id === OFFICIAL_CATALOG_PROFILE_ID);
        assert.equal(official?.baseUrl, OFFICIAL_CATALOG_URL);
        assert.equal(official?.name, 'SheetDelver Official Catalog');
        assert.equal(official?.enabled, false);
        assert.equal(official?.priority, 37);
        const migrated = profiles.find((profile) => profile.id === 'legacy-custom');
        assert.equal(migrated?.trustTier, 'unverified');
        assert.equal(migrated ? 'auth' in migrated : true, false);
        assert.equal(migrated ? 'hostAllowlist' in migrated : true, false);

        const created = createSourceProfile({
            name: ' Community ',
            baseUrl: 'https://community.example/catalog.json#ignored',
        });
        assert.equal(created.name, 'Community');
        assert.equal(created.baseUrl, 'https://community.example/catalog.json');
        assert.equal(created.trustTier, 'unverified');
        assert.equal(created.kind, 'indexed');

        assert.throws(
            () => updateSourceProfile(OFFICIAL_CATALOG_PROFILE_ID, { baseUrl: 'https://evil.example/catalog.json' }),
            /official catalog identity/,
        );
        assert.throws(() => deleteSourceProfile(OFFICIAL_CATALOG_PROFILE_ID), /protected/);
        assert.throws(() => deleteSourceProfile('local-default'), /protected/);
        assert.equal(deleteSourceProfile(created.id), true);

        const persisted = fs.readFileSync(profilesFile, 'utf8');
        assert.equal(persisted.includes('must-be-removed'), false);
        assert.equal(persisted.includes('https://sheetdelver.github.io/module-catalog/catalog.json'), false);
        if (process.platform !== 'win32') {
            assert.equal(fs.statSync(profilesFile).mode & 0o777, 0o600);
        }
    } finally {
        __resetSourceProfilesForTests();
        __resetDataDirForTests(previousDataDir);
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        run();
        console.log('public-catalog-profiles.test.ts passed');
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
}
