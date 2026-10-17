import { parentPort, workerData } from 'node:worker_threads';
import { UpgradeJournal } from './UpgradeJournal';
import { sourceHash } from './planner';
const journal = new UpgradeJournal(workerData.root, workerData.lockRoot);
function encode(value: any, known: Set<string>): any {
    if (Array.isArray(value)) return value.map(row => encode(row, known));
    if (!value?.plan?.operations) return value;
    const reference = journal.planReference(value.plan);
    return { ...value, plan: { __upgradePlan: reference, ...known.has(reference.digest) ? {} : { value: value.plan } } };
}
parentPort!.on('message', ({ id, method, args, known }) => {
    try {
        if (!['savePreview', 'preview', 'saveSourceCandidate', 'sourceCandidate', 'save', 'job', 'jobs', 'recoverJob'].includes(method)) throw new Error('Invalid upgrade storage operation');
        const values = args.map((value: any) => {
            if (value?.plan?.__upgradePlan) return { ...value, plan: journal.resolvePlan(value.plan.__upgradePlan) };
            if (value?.plan?.operations) {
                const { digest, diagnostics: _diagnostics, ...body } = value.plan;
                if (sourceHash(body) !== digest) throw new Error('Migration logical approval digest mismatch');
            }
            return value;
        });
        const result = (journal[method as keyof UpgradeJournal] as (...args: any[]) => unknown).apply(journal, values);
        parentPort!.postMessage({ id, value: encode(result, new Set(known)) });
    } catch (error) { parentPort!.postMessage({ id, error: error instanceof Error ? error.message : 'Upgrade storage failed' }); }
});
