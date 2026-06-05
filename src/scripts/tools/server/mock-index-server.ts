import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { resolveDataDir, initDataDir, getDistModulesDir } from '../../../server/core/paths';
import { logger } from '../../../shared/utils/logger';

initDataDir(resolveDataDir());

const app = express();
const PORT = 3005;

app.use(cors());

interface ModuleInfo {
    moduleId: string;
    title: string;
    latestVersion: string;
    versions: {
        [version: string]: {
            source: string;
            publishedAt: number;
            integrity: string;
            signature: string;
            compatibility: {
                [key: string]: string; // e.g. "coreVersion": ">=0.1.0"
            };
        };
    };
}

function getLocalModuleDetails(distPath: string): ModuleInfo[] {
    if (!fs.existsSync(distPath)) return [];
    const files = fs.readdirSync(distPath);
    logger.info(`[MockServer] Scanning dist/modules for tarballs [${files.length}] at ${new Date(Date.now()).toLocaleString()}`);
    const modules = [];

    for (const file of files) {
        logger.info(`[MockServer] Found tarball: ${file} in dist/modules at ${new Date(Date.now()).toLocaleString()}`);
        const name = file.replace('-*.tgz', '');
        const version = file.replace(`${name}-`, '').replace('.tgz', '');
        logger.info(`[MockServer] Detected module: ${name} from tarball name at ${new Date(Date.now()).toLocaleString()}`);
        const hash = crypto.createHash('sha256');
        hash.update(fs.readFileSync(path.join(distPath, file)));
        const integrity = `sha256:${hash.digest('hex')}`;
        logger.info(`[MockServer] Calculated integrity for ${file}: ${integrity} at ${new Date(Date.now()).toLocaleString()}`);
        modules.push({
            moduleId: name,
            title: `${name} (Mock)`,
            latestVersion: version,
            versions: {
                [version]: {
                    source: `http://localhost:${PORT}/download/${file}`,
                    publishedAt: fs.statSync(path.join(distPath, file)).mtimeMs,
                    integrity,
                    signature: `minisign:mock-${name}-signature`,
                    compatibility: {
                        "module-api": ">=1.0.0 <2.0.0"
                    }
                }
            }
        });
    }
    return modules;
}

// Serve static files from dist/modules at /download
const distPath = getDistModulesDir();
app.use('/download', express.static(distPath));
const modules = getLocalModuleDetails(distPath);

app.get('/', (req, res) => {
    // Dynamically build index
    const MOCK_INDEX = {
        schemaVersion: "1.0",
        publisher: "Test Environment Mock Index",
        generatedAt: Date.now(),
        modules: {
            "test-module": {
                moduleId: "test-module",
                title: "Test Module",
                latestVersion: "1.0.0",
                versions: {
                    "1.0.0": {
                        source: "local://test-module",
                        publishedAt: Date.now(),
                        compatibility: {
                            coreVersion: ">=0.1.0"
                        }
                    }
                }
            },
            ...modules
        }
    };

    res.json(MOCK_INDEX);
    logger.info(`[MockServer] Served index at http://localhost:${PORT}/ to ${req.ip} at ${new Date(Date.now()).toLocaleString()}`);
});

app.listen(PORT, () => {
    logger.info(`[MockServer] Mock Index Server running at http://localhost:${PORT} started at ${new Date(Date.now()).toLocaleString()}`);
    logger.info(`[MockServer] Serving index at http://localhost:${PORT}/ and tarballs at http://localhost:${PORT}/download`);
});
