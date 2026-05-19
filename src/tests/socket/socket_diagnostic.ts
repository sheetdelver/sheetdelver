import { CoreSocket } from '@core/foundry/sockets/CoreSocket';
import { loadConfig } from '@core/config';
import { worldStateStore } from '@core/world/WorldStateStore';
import { logger } from '@shared/utils/logger';
import fs from 'fs';
import path from 'path';

async function runDiagnostic() {
    // 1. Initialize Configuration
    const config = await loadConfig();
    if (!config || !config.foundry) {
        logger.error("Failed to load configuration. Check your .env file.");
        return;
    }

    // 2. Initialize Socket and Connect (Handles handshake/login internally)
    const socket = new CoreSocket(config.foundry);
    logger.info("📡 Connecting to Foundry VTT...");

    try {
        await socket.connect();
        logger.info("✅ Connected successfully!");

        // 3. Verify System Version
        const system = worldStateStore.getSystem();
        if (!system) throw new Error('System metadata unavailable');
        logger.info(`System Detected: ${system.id} v${system.version}`);
        /*
        if (system.id !== 'shadowdark') {
            logger.warn(`Current world system is '${system.id}', not 'shadowdark'. Results may vary.`);
        }

        // 4. Load Mapping
        const mappingPath = path.join(process.cwd(), 'src/modules/shadowdark/data/shadowdarkling/map-shadowdarkling.json');
        if (!fs.existsSync(mappingPath)) {
            logger.error(`Mapping file not found at: ${mappingPath}`);
            return;
        }
        const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));

        // Test sample UUIDs (Normalized to 4-part as per Shadowdark v3.x)
        const testUuids = [
            "Compendium.shadowdark.talents.FIHNdRhD6DHFxSkC", // AddWISToRolls
            "Compendium.shadowdark.ancestries.0lJ8Pj0UPsbSSUTm", // Half-Orc
            "Compendium.shadowdark.gear.DeqtKQQzI6HTYvV0" // Chainmail
        ];

        logger.info("--- Testing UUID Formats ---");
        for (const uuid of testUuids) {
            logger.info(`Fetching: ${uuid}...`);
            try {
                const doc = await socket.fetchByUuid(uuid);
                if (doc) {
                    logger.info(`  SUCCESS: Found '${doc.name}' (${doc.type}) via ${uuid}`);
                } else {
                    logger.warn(`  FAILED: Document not found via ${uuid}`);
                    
                    // Fallback check: Does the legacy format work?
                    const parts = uuid.split('.');
                    const legacyUuid = `Compendium.${parts[1]}.${parts[2]}.Item.${parts[3]}`;
                    logger.info(`  RETRYING Legacy Format: ${legacyUuid}...`);
                    const legacyDoc = await socket.fetchByUuid(legacyUuid);
                    if (legacyDoc) {
                        logger.info(`  SUCCESS (Legacy): Found '${legacyDoc.name}' via ${legacyUuid}`);
                    }
                }
            } catch (e) {
                logger.error(`  ERROR fetching ${uuid}: ${e}`);
            }
        }

        // 5. Discover All Item Compendiums
        logger.info("--- Discovering Compendiums via ShadowdarkAdapter ---");
        const { ShadowdarkAdapter } = await import('../../modules/shadowdark/src/server/ShadowdarkAdapter');
        const data = await new ShadowdarkAdapter().getSystemData(socket);
        
        logger.info(`Discovery complete. Found ${data.ancestries?.length || 0} ancestries and ${data.items?.length || 0} gear items.`);
        
        if (data.items && data.items.length > 0) {
            const first = data.items[0];
            logger.info(`Example Item Discovery: ${first.name} -> UUID: ${first.uuid}`);
            if (first.uuid && first.uuid.split('.').length === 4) {
                logger.info("  [VERIFIED] Discovery is generating 4-part UUIDs.");
            } else {
                logger.warn(`  [WARNING] Discovery generated a ${first.uuid.split('.').length}-part UUID: ${first.uuid}`);
            }
        }

        // 7. Verify Base Class Traits (Enrichment Logic)
        logger.info("--- Verifying Enrichment Logic (Class Base Traits) ---");
        
        // Find Fighter, Wizard, Warlock, and Orc
        const classes = (data.classes || []) as any[];
        const ancestries = (data.ancestries || []) as any[];
        
        const fighter = classes.find((c: any) => c.name === "Fighter");
        const wizard = classes.find((c: any) => c.name === "Wizard");
        const warlock = classes.find((c: any) => c.name === "Warlock");
        const halfOrc = ancestries.find((a: any) => a.name === "Half-Orc");

        const targets = [
            { doc: fighter, expected: "Weapon Mastery" },
            { doc: wizard, expected: "Spellcasting (Wizard)" },
            { doc: warlock, expected: "Patron" },
            { doc: halfOrc, expected: "Mighty" }
        ];
        
        for (const target of targets) {
            if (!target.doc) {
                logger.warn(`Target document not found for: ${target.expected}`);
                continue;
            }
            
            logger.info(`Testing Document: ${target.doc.name} (${target.doc.uuid})`);
            const fullDoc = await socket.fetchByUuid(target.doc.uuid);
            if (fullDoc) {
                const { resolveSubItems } = await import('../../modules/shadowdark/src/logic/actor-enricher');
                const enrichmentContext = {
                    addedSourceIds: new Set<string>(),
                    addedNames: new Set<string>(),
                    targetLevel: 1,
                    actor: { name: "Test Actor", system: { abilities: {} } }
                };
                
                const resolveDoc = (uuid: string) => socket.fetchByUuid(uuid);
                const baseTraits = await resolveSubItems(fullDoc, resolveDoc, enrichmentContext);
                
                logger.info(`${fullDoc.name} has ${baseTraits.length} base traits resolved.`);
                baseTraits.forEach((t: any) => logger.info(`  - [FOUND] ${t.name}`));
                
                const found = baseTraits.some((t: any) => t.name.toLowerCase().includes(target.expected.toLowerCase()));
                if (found) logger.info(`✅ SUCCESS: ${target.expected} found!`);
                else {
                    logger.error(`❌ FAILED: ${target.expected} missing!`);
                    // Dump the system data to see what we missed
                    logger.info(`  [DEBUG] system.talents: ${JSON.stringify(fullDoc.system?.talents || [])}`);
                    logger.info(`  [DEBUG] system.features: ${JSON.stringify(fullDoc.system?.features || [])}`);
                    logger.info(`  [DEBUG] system.abilities: ${JSON.stringify(fullDoc.system?.abilities || [])}`);
                    if (fullDoc.system?.classAbilities) {
                        logger.info(`  [DEBUG] system.classAbilities: ${JSON.stringify(fullDoc.system.classAbilities)}`);
                    }
                }
            }
        }
        */

    } catch (e) {
        logger.error(`  ERROR during diagnostic: ${e}`);
    } finally {
        await socket.disconnect();
        logger.info("📡 Disconnected");
    }
}

runDiagnostic().catch(logger.error);
