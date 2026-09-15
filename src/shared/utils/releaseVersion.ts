interface SemanticVersion {
    major: number;
    minor: number;
    patch: number;
    prerelease: string[];
}

function parseSemanticVersion(version: string): SemanticVersion | undefined {
    const match = version.trim().match(
        /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
    );
    if (!match) return undefined;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4]?.split('.') || [],
    };
}

function comparePrereleaseIdentifiers(left: string[], right: string[]): number {
    if (left.length === 0 || right.length === 0) {
        if (left.length === right.length) return 0;
        return left.length === 0 ? 1 : -1;
    }

    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        const leftValue = left[index];
        const rightValue = right[index];
        if (leftValue === undefined || rightValue === undefined) {
            return leftValue === rightValue ? 0 : leftValue === undefined ? -1 : 1;
        }
        if (leftValue === rightValue) continue;

        const leftNumeric = /^\d+$/.test(leftValue);
        const rightNumeric = /^\d+$/.test(rightValue);
        if (leftNumeric && rightNumeric) return Number(leftValue) - Number(rightValue);
        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
        return leftValue.localeCompare(rightValue);
    }
    return 0;
}

export function compareReleaseVersions(left: string, right: string): number {
    const leftVersion = parseSemanticVersion(left);
    const rightVersion = parseSemanticVersion(right);
    if (!leftVersion || !rightVersion) {
        return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
    }

    for (const field of ['major', 'minor', 'patch'] as const) {
        if (leftVersion[field] !== rightVersion[field]) {
            return leftVersion[field] - rightVersion[field];
        }
    }
    return comparePrereleaseIdentifiers(leftVersion.prerelease, rightVersion.prerelease);
}
