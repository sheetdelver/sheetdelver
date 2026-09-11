export interface CatalogReleaseIdentity {
    version: string;
    integrity?: string;
}

export function isInstalledReleaseCurrent(
    release?: CatalogReleaseIdentity | null,
    installed?: CatalogReleaseIdentity | null,
): boolean {
    return Boolean(
        release
        && installed
        && release.version === installed.version
        && release.integrity
        && installed.integrity
        && release.integrity === installed.integrity,
    );
}
