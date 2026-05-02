import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import stream from 'node:stream/promises';
import * as tar from 'tar';
import extractZip from 'extract-zip';
import { getModulesDataDir, getDistArchivesDir } from '@server/core/paths';

export class ArtifactExtractionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ArtifactExtractionError';
    }
}

/**
 * Downloads an archive from a source URL, verifies its integrity,
 * and extracts it into the active modules data directory.
 * Supported formats: .tgz, .tar.gz, .tar, .zip
 */
export async function fetchAndExtractArtifact(
    moduleId: string,
    sourceUrl: string,
    expectedIntegrity?: string
): Promise<void> {
    const isZip = sourceUrl.toLowerCase().includes('.zip');
    const ext = isZip ? '.zip' : '.tgz';
    
    const archivesDir = getDistArchivesDir();
    if (!fs.existsSync(archivesDir)) {
        fs.mkdirSync(archivesDir, { recursive: true });
    }

    let archiveFile = '';
    let needsDownload = true;

    if (expectedIntegrity) {
        // Safe filename from hash
        const safeHash = expectedIntegrity.replace(/[^a-zA-Z0-9]/g, '');
        archiveFile = path.join(archivesDir, `${moduleId}-${safeHash}${ext}`);
        
        if (fs.existsSync(archiveFile)) {
            // Verify existing file matches hash
            const hash = crypto.createHash('sha256');
            const fileBuffer = fs.readFileSync(archiveFile);
            hash.update(fileBuffer);
            const actualIntegrity = `sha256:${hash.digest('hex')}`;
            
            if (actualIntegrity === expectedIntegrity) {
                needsDownload = false;
            } else {
                // Invalid cache, remove it
                fs.unlinkSync(archiveFile);
            }
        }
    } else {
        // No integrity, force download to a unique temp file in archives dir
        archiveFile = path.join(archivesDir, `${moduleId}-latest-${Date.now()}${ext}`);
    }

    if (needsDownload) {
        const response = await fetch(sourceUrl);
        if (!response.ok) {
            throw new ArtifactExtractionError(`Failed to download artifact: ${response.status} ${response.statusText}`);
        }

        const destStream = fs.createWriteStream(archiveFile);
        
        if (response.body) {
            // Using modern Web Streams to Node.js stream pipeline
            // @ts-ignore - response.body is ReadableStream, which stream.pipeline accepts in newer Node versions
            await stream.pipeline(response.body, destStream);
        } else {
            const buffer = await response.arrayBuffer();
            fs.writeFileSync(archiveFile, Buffer.from(buffer));
        }

        // Verify integrity after download
        if (expectedIntegrity) {
            const hash = crypto.createHash('sha256');
            const fileBuffer = fs.readFileSync(archiveFile);
            hash.update(fileBuffer);
            const actualIntegrity = `sha256:${hash.digest('hex')}`;
            
            if (actualIntegrity !== expectedIntegrity) {
                fs.unlinkSync(archiveFile);
                throw new ArtifactExtractionError(`Integrity check failed. Expected: ${expectedIntegrity}, Actual: ${actualIntegrity}`);
            }
        }
    }

        // Target extraction directory
        const targetDir = path.join(getModulesDataDir(), moduleId);
        
        // Clear target dir if it exists
        if (fs.existsSync(targetDir)) {
            fs.rmSync(targetDir, { recursive: true, force: true });
        }
        fs.mkdirSync(targetDir, { recursive: true });
        
        try {
            if (isZip) {
                await extractZip(archiveFile, { dir: targetDir });
            } else {
                // Assume tar or tgz
                await tar.extract({
                    file: archiveFile,
                    cwd: targetDir,
                });
            }
        } catch (err) {
            throw new ArtifactExtractionError(`Extraction failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Clean up temp file if no integrity was provided (since we can't cache it safely)
        if (!expectedIntegrity && fs.existsSync(archiveFile)) {
            fs.unlinkSync(archiveFile);
        }
}
