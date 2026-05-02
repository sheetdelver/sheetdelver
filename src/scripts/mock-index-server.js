// scripts/mock-index-server.js
import http from 'http';
import { logger } from '../src/shared/utils/logger';

const PORT = 3005;

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
        }
    }
};

const server = http.createServer((req, res) => {
    // Add CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.url === '/' && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify(MOCK_INDEX, null, 2));
        // Request sent to client
        logger.info(`[MockIndexServer] Request sent to client ${req.socket.remoteAddress} ${req.url}`);
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

server.listen(PORT, () => {
    logger.info(`Mock Index Server running at http://localhost:${PORT}`);
    logger.info('Use this URL in the Source Profiles panel to test connectivity.');
});
