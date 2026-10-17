// Acceptance-only observer. It changes no host behavior and imports no host
// services: the external fixture races a native observation at a real worker.
import { createHook } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { isMainThread } from 'node:worker_threads';

const directory = process.env.SD_READINESS_PROBE;
let count = 0;
if (directory && isMainThread) createHook({ init(_id, type) {
    if (type !== 'WORKER' || !new Error().stack?.includes('computeWorldMigrations')) return;
    count++;
    fs.writeFileSync(path.join(directory, `workers-${process.pid}.json`), JSON.stringify({ count }));
    const arm = path.join(directory, 'readiness-arm.json');
    if (!fs.existsSync(arm)) return;
    const wanted = JSON.parse(fs.readFileSync(arm, 'utf8'));
    if (wanted.pid && wanted.pid !== process.pid || wanted.count !== count) return;
    if (wanted.activating) {
        const mode = path.join(directory, 'data/config/module-upgrades/maintenance.json');
        if (!fs.existsSync(mode) || JSON.parse(fs.readFileSync(mode, 'utf8')).stage !== 'activating') return;
    }
    fs.unlinkSync(arm);
    fs.writeFileSync(path.join(directory, 'readiness-signal.json'), JSON.stringify({ pid: process.pid, count }));
} }).enable();
