import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface V8CoverageFile {
    result?: Array<{
        url: string;
        functions: Array<{
            ranges: Array<{
                startOffset: number;
                endOffset: number;
                count: number;
            }>;
        }>;
    }>;
}

interface CoverageRange {
    startOffset: number;
    endOffset: number;
    count: number;
}

interface FileLineSummary {
    file: string;
    covered: number;
    total: number;
    percent: number;
}

const cwd = process.cwd();
const coverageDir = path.join(cwd, 'coverage', 'unit');
const rawDir = path.join(coverageDir, 'v8');
const jsonSummaryPath = path.join(coverageDir, 'summary.json');
const markdownSummaryPath = path.join(coverageDir, 'summary.md');

function toPercent(covered: number, total: number): number {
    return total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2));
}

function isSourceFile(filePath: string): boolean {
    const relative = path.relative(cwd, filePath).replaceAll(path.sep, '/');
    if (!relative.startsWith('src/')) return false;
    if (relative.startsWith('src/tests/')) return false;
    if (relative.startsWith('src/scripts/')) return false;
    if (relative.endsWith('.d.ts')) return false;
    return /\.(ts|tsx|js|jsx)$/.test(relative);
}

function listSourceFiles(dir: string): string[] {
    const files: string[] = [];
    if (!fs.existsSync(dir)) return files;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...listSourceFiles(fullPath));
        } else if (isSourceFile(fullPath)) {
            files.push(fullPath);
        }
    }

    return files;
}

function filePathFromUrl(url: string): string | null {
    if (!url.startsWith('file://')) return null;
    try {
        return fileURLToPath(url.split('?')[0]);
    } catch {
        return null;
    }
}

function isCoverableLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('//')) return false;
    if (trimmed.startsWith('/*')) return false;
    if (trimmed.startsWith('*')) return false;
    if (trimmed.startsWith('*/')) return false;
    return true;
}

function lineStartOffsets(source: string): number[] {
    const starts = [0];
    for (let index = 0; index < source.length; index++) {
        if (source[index] === '\n') starts.push(index + 1);
    }
    return starts;
}

function firstCodeOffset(line: string, lineStart: number): number {
    const match = /\S/.exec(line);
    return lineStart + (match?.index ?? 0);
}

function innermostRangeAt(ranges: CoverageRange[], offset: number): CoverageRange | null {
    let best: CoverageRange | null = null;
    for (const range of ranges) {
        if (range.startOffset > offset || range.endOffset <= offset) continue;
        if (!best || (range.endOffset - range.startOffset) < (best.endOffset - best.startOffset)) {
            best = range;
        }
    }
    return best;
}

function summarizeFile(filePath: string, ranges: CoverageRange[]): FileLineSummary {
    const source = fs.readFileSync(filePath, 'utf8');
    const starts = lineStartOffsets(source);
    const lines = source.split(/\r?\n/);
    let covered = 0;
    let total = 0;

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!isCoverableLine(line)) continue;
        total += 1;

        const offset = firstCodeOffset(line, starts[index] ?? 0);
        const range = innermostRangeAt(ranges, offset);
        if (range && range.count > 0) covered += 1;
    }

    return {
        file: path.relative(cwd, filePath).replaceAll(path.sep, '/'),
        covered,
        total,
        percent: toPercent(covered, total),
    };
}

function collectRanges(): Map<string, CoverageRange[]> {
    const rangesByFile = new Map<string, CoverageRange[]>();
    const files = fs.existsSync(rawDir)
        ? fs.readdirSync(rawDir).filter((file) => file.endsWith('.json'))
        : [];

    for (const file of files) {
        const raw = JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf8')) as V8CoverageFile;
        for (const script of raw.result || []) {
            const filePath = filePathFromUrl(script.url);
            if (!filePath || !isSourceFile(filePath)) continue;
            const ranges = rangesByFile.get(filePath) || [];
            for (const fn of script.functions) {
                ranges.push(...fn.ranges);
            }
            rangesByFile.set(filePath, ranges);
        }
    }

    return rangesByFile;
}

function runUnitTestsWithCoverage(): void {
    fs.rmSync(coverageDir, { recursive: true, force: true });
    fs.mkdirSync(rawDir, { recursive: true });

    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = spawnSync(npmCommand, ['run', 'test:unit'], {
        cwd,
        stdio: 'inherit',
        env: {
            ...process.env,
            NODE_V8_COVERAGE: rawDir,
        },
    });

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

function writeSummaries(files: FileLineSummary[]): void {
    const totals = files.reduce(
        (acc, file) => {
            acc.covered += file.covered;
            acc.total += file.total;
            return acc;
        },
        { covered: 0, total: 0 },
    );

    const summary = {
        generatedAt: new Date().toISOString(),
        command: 'npm run coverage:unit',
        testCommand: 'npm run test:unit',
        coverageSource: 'NODE_V8_COVERAGE raw ranges summarized against nonblank, non-comment source lines',
        include: 'src/**/*.{ts,tsx,js,jsx}',
        exclude: ['src/tests/**', 'src/scripts/**', '**/*.d.ts'],
        lines: {
            covered: totals.covered,
            total: totals.total,
            percent: toPercent(totals.covered, totals.total),
        },
        files,
        leastCoveredFiles: [...files]
            .filter((file) => file.total > 0)
            .sort((a, b) => a.percent - b.percent || b.total - a.total)
            .slice(0, 20),
    };

    fs.writeFileSync(jsonSummaryPath, JSON.stringify(summary, null, 2) + '\n');

    const markdown = [
        '# Unit Coverage Summary',
        '',
        `Generated: ${summary.generatedAt}`,
        '',
        `Line coverage: ${summary.lines.covered}/${summary.lines.total} (${summary.lines.percent}%)`,
        '',
        'Least-covered files:',
        '',
        '| File | Covered | Total | Percent |',
        '| --- | ---: | ---: | ---: |',
        ...summary.leastCoveredFiles.map((file) => (
            `| ${file.file} | ${file.covered} | ${file.total} | ${file.percent}% |`
        )),
        '',
    ].join('\n');

    fs.writeFileSync(markdownSummaryPath, markdown);
    console.log(`Unit coverage: ${summary.lines.covered}/${summary.lines.total} lines (${summary.lines.percent}%)`);
    console.log(`Wrote ${path.relative(cwd, jsonSummaryPath)} and ${path.relative(cwd, markdownSummaryPath)}`);
}

runUnitTestsWithCoverage();
const rangesByFile = collectRanges();
const summaries = listSourceFiles(path.join(cwd, 'src'))
    .map((file) => summarizeFile(file, rangesByFile.get(file) || []))
    .sort((a, b) => a.file.localeCompare(b.file));
writeSummaries(summaries);
