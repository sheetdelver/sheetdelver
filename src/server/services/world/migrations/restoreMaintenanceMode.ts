import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '@core/paths';
import { readMaintenanceMode, saveMaintenanceMode } from '@core/world/MaintenanceMode';
import { UpgradeJournal } from './UpgradeJournal';

/** Existing approved jobs retain their exact approval in the maintenance composition. */
export function restoreLegacyMaintenanceMode(): void {
    if (readMaintenanceMode()) return;
    const jobs = path.join(getDataDir(), 'config/module-upgrades/jobs');
    if (!fs.existsSync(jobs)) return;
    const journal = new UpgradeJournal(path.dirname(jobs));
    for (const file of fs.readdirSync(jobs).filter(name => /^[a-zA-Z0-9-]+\.json$/.test(name))) {
        try {
            const job = journal.job(file.slice(0, -5));
            if (['completed', 'cancelled'].includes(job.phase)) continue;
            if (!job.jobId || !job.moduleId || !job.plan?.world?.identity) throw new Error('Invalid legacy pending job');
            saveMaintenanceMode({ schemaVersion: 1, id: job.jobId, jobId: job.jobId, moduleId: job.moduleId,
                stage: job.phase === 'recovery-required' ? 'recovery-required' : 'executing',
                world: job.plan.world.identity, leaseToken: job.leaseToken,
                // Historical file intent and these phases were persisted after drain.
                // Quiescing or a generic failure alone is not proof of settlement.
                drained: job.possibleWrite || ['installing', 'restarting', 'migrating', 'verifying'].includes(job.phase)
                    || ['intent', 'previous-retained', 'promoted', 'registered'].includes(job.fileTransition ?? ''), updatedAt: Date.now() });
            return;
        } catch {
            saveMaintenanceMode({ schemaVersion: 1, id: 'unreadable-journal', moduleId: 'unknown', stage: 'recovery-required', diagnosticOnly: true,
                failure: 'Upgrade journal is unreadable. Preserve config/module-upgrades, restore validated records and restart. Ordinary runtime and writes remain stopped.', updatedAt: Date.now() });
            return;
        }
    }
}
