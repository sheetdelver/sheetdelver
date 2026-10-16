import { UpgradeJournal } from '@server/services/world/migrations/UpgradeJournal';

// Offline crash fixture: owns only its supplied temporary durable journal.
const journal = new UpgradeJournal(process.argv[2]);
const job = journal.job(process.argv[3]);
job.leaseToken = journal.acquire(job);
journal.save(job);
process.exit(17);
