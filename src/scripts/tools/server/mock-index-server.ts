import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { resolveDataDir, initDataDir, getDistModulesDir } from '../../../server/core/paths';

initDataDir(resolveDataDir());

const app = express();
const PORT = 3005;

app.use(cors());

// Serve static files from dist/modules at /download
const distPath = getDistModulesDir();
app.use('/download', express.static(distPath));

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
            "dnd5e": {}
        }
    };

    // If dnd5e is packaged, add it to the index
    if (fs.existsSync(distPath)) {
        const files = fs.readdirSync(distPath);
        for (const file of files) {
            if (file.startsWith('dnd5e-') && file.endsWith('.tgz')) {
                const version = file.replace('dnd5e-', '').replace('.tgz', '');
                const filePath = path.join(distPath, file);
                const hash = crypto.createHash('sha256');
                hash.update(fs.readFileSync(filePath));
                const integrity = `sha256:${hash.digest('hex')}`;

                MOCK_INDEX.modules['dnd5e'] = {
                    moduleId: 'dnd5e',
                    title: 'D&D 5th Edition (Mock)',
                    latestVersion: version,
                    versions: {
                        [version]: {
                            source: `http://localhost:${PORT}/download/${file}`,
                            publishedAt: fs.statSync(filePath).mtimeMs,
                            integrity,
                            compatibility: {
                                "module-api": ">=1.0.0 <2.0.0"
                            }
                        }
                    }
                };
            }
        }
    }

    res.json(MOCK_INDEX);
});

app.listen(PORT, () => {
    console.log(`Mock Index Server running at http://localhost:${PORT}`);
    console.log('Serving index at / and tarballs at /download');
});
