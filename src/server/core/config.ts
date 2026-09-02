// Server-only dynamic imports to prevent client-side build crashes while remaining ESM-compliant
const getFs = async () => (typeof window === 'undefined' ? (await import('node:fs')).promises : null);
const getPath = async () => (typeof window === 'undefined' ? await import('node:path') : null);
const getYaml = async () => (typeof window === 'undefined' ? await import('js-yaml') : null);

import { AppConfig } from '@shared/interfaces';
import { logger } from '@shared/utils/logger';
import { getConfigFilePath, getDataDir } from '@core/paths';
import { resolveAdminOrigin } from '@shared/security/adminOrigin';
import { resolveExternalSecret } from '@server/security/externalSecret';
import {
    DEFAULT_ADMIN_ALLOWED_NETWORKS,
    validateAdminAllowedNetworks,
} from '@server/security/adminNetwork';

let _cachedConfig: AppConfig | null = null;

function parseBoolean(value: string | undefined): boolean | undefined {
    if (!value) return undefined;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    return undefined;
}

function parseCsv(value: string | undefined): string[] | undefined {
    if (!value) return undefined;
    const items = value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    return items.length > 0 ? items : undefined;
}

function parseTrustTier(
    value: string | undefined
): 'first-party' | 'verified-third-party' | 'unverified' | undefined {
    if (!value) return undefined;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'first-party') return 'first-party';
    if (normalized === 'verified-third-party') return 'verified-third-party';
    if (normalized === 'unverified') return 'unverified';
    return undefined;
}

export function resolveModulePolicyConfig(
    securityDoc: any,
    env: NodeJS.ProcessEnv = process.env
): {
    minimumTrustTier: 'first-party' | 'verified-third-party' | 'unverified';
    allowUnverifiedInDevelopment: boolean;
    requireAdminOverrideForLowerTrust: boolean;
    requirePermissionEscalationApproval: boolean;
} {
    const modulePolicyDoc = securityDoc?.['module-policy'] || {};
    const isProduction = env.NODE_ENV === 'production';

    const envMinTier = parseTrustTier(env.APP_MODULE_POLICY_MINIMUM_TRUST_TIER);
    const fileMinTier = parseTrustTier(modulePolicyDoc['minimum-trust-tier']);
    const minimumTrustTier = envMinTier || fileMinTier || (isProduction ? 'verified-third-party' : 'unverified');

    const envAllowUnverifiedDev = parseBoolean(env.APP_MODULE_POLICY_ALLOW_UNVERIFIED_IN_DEVELOPMENT);
    const fileAllowUnverifiedDev = modulePolicyDoc['allow-unverified-in-development'];
    const allowUnverifiedInDevelopment =
        envAllowUnverifiedDev
        ?? (typeof fileAllowUnverifiedDev === 'boolean' ? fileAllowUnverifiedDev : !isProduction);

    const envRequireOverride = parseBoolean(env.APP_MODULE_POLICY_REQUIRE_ADMIN_OVERRIDE_FOR_LOWER_TRUST);
    const fileRequireOverride = modulePolicyDoc['require-admin-override-for-lower-trust'];
    const requireAdminOverrideForLowerTrust =
        envRequireOverride
        ?? (typeof fileRequireOverride === 'boolean' ? fileRequireOverride : isProduction);

    const envRequirePermissionApproval = parseBoolean(env.APP_MODULE_POLICY_REQUIRE_PERMISSION_ESCALATION_APPROVAL);
    const fileRequirePermissionApproval = modulePolicyDoc['require-permission-escalation-approval'];
    const requirePermissionEscalationApproval =
        envRequirePermissionApproval
        ?? (typeof fileRequirePermissionApproval === 'boolean' ? fileRequirePermissionApproval : true);

    return {
        minimumTrustTier,
        allowUnverifiedInDevelopment,
        requireAdminOverrideForLowerTrust,
        requirePermissionEscalationApproval,
    };
}

export async function loadConfig(): Promise<AppConfig | null> {
    if (_cachedConfig) return _cachedConfig;

    // Browser Fallback (Config is typically injected or fetched via API on client)
    if (typeof window !== 'undefined') {
        return null;
    }

    const fs = await getFs();
    const path = await getPath();
    const yaml = await getYaml();

    if (!fs || !path || !yaml) {
        throw new Error('Server-side modules failed to load in non-browser context');
    }

    try {
        // Read settings.yaml from the resolved data directory (<DATA_DIR>/config/settings.yaml)
        const configPath = getConfigFilePath();
        const fileContents = await fs.readFile(configPath, 'utf8');
        const doc = yaml.load(fileContents) as any;

        // Read version from package.json
        const packagePath = path.resolve(process.cwd(), 'package.json');
        const packageJson = JSON.parse(await fs.readFile(packagePath, 'utf8'));
        const version = packageJson.version || '0.0.0';

        if (doc) {
            if (!doc.app) throw new Error('Missing "app" section in settings.yaml');
            const app = doc.app;
            const foundry = doc.foundry || {};
            const debug = doc.debug || {};

            const envUrl = process.env.FOUNDRY_URL;
            const envHost = process.env.FOUNDRY_HOST;
            const envPort = process.env.FOUNDRY_PORT ? parseInt(process.env.FOUNDRY_PORT) : undefined;
            const envProtocol = process.env.FOUNDRY_PROTOCOL;
            const envUsername = process.env.FOUNDRY_USERNAME;
            const envPassword = process.env.FOUNDRY_PASSWORD;
            const envServiceToken = process.env.APP_SERVICE_TOKEN;
            const envAdminPepper = process.env.APP_ADMIN_PEPPER;
            const envAllowLiveCompendiumUuidFallback = parseBoolean(process.env.APP_ALLOW_LIVE_COMPENDIUM_UUID_FALLBACK);
            const envCorsAllowAllOrigins = parseBoolean(process.env.APP_CORS_ALLOW_ALL_ORIGINS);
            const envCorsAllowedOrigins = parseCsv(process.env.APP_CORS_ALLOWED_ORIGINS);

            const protocol = envProtocol || foundry.protocol;
            const host = envHost || foundry.host;
            const port = envPort || foundry.port;

            if (!protocol || !host || !port) {
                throw new Error('Missing mandatory "foundry" fields (protocol, host, port) in settings.yaml');
            }

            const isStandardPort = (protocol === 'http' && port === 80) || (protocol === 'https' && port === 443);

            // Priority: Env URL -> Constructed from Env Host/Port -> Config URL -> Constructed from Config Host/Port
            const foundryUrl = envUrl || (envHost ? `${protocol}://${host}${isStandardPort ? '' : `:${port}`}` : null) || foundry.url || `${protocol}://${host}${isStandardPort ? '' : `:${port}`}`;

            const appProtocol = app.protocol;
            const appHost = app.host;
            const appPort = app.port;

            if (!appProtocol || !appHost || !appPort) {
                throw new Error('Missing mandatory "app" fields (protocol, host, port) in settings.yaml');
            }

            const isStandardAppPort = (appProtocol === 'http' && appPort === 80) || (appProtocol === 'https' && appPort === 443);
            const appUrl = `${appProtocol}://${appHost}${isStandardAppPort ? '' : `:${appPort}`}`;
            // Admin settings are optional for existing installations. Resolution
            // still fails closed if an operator attempts a non-loopback host.
            const adminOrigin = resolveAdminOrigin({
                appOrigin: appUrl,
                configuredOrigin: app['admin-origin'],
            });

            const security = doc.security || {};
            if (security['admin-setup-token'] !== undefined || process.env.APP_ADMIN_SETUP_TOKEN) {
                logger.warn('[Config] Legacy admin setup/reset token is ignored; use npm run admin:bootstrap or npm run admin:recover.');
            }
            const resolveConfiguredSecret = (
                envValue: string | undefined,
                configuredValue: unknown,
                label: string,
                requireOutsideDataDir = false,
            ): string | undefined => {
                if (envValue) return envValue;
                const resolved = resolveExternalSecret(configuredValue, label, {
                    dataDir: getDataDir(),
                    requireOutsideDataDir,
                });
                if (resolved?.source === 'legacy-inline') {
                    logger.warn(`[Config] ${label} uses a legacy inline value; migrate it to an external env/file reference.`);
                }
                return resolved?.value;
            };
            const resolvedFoundryPassword = resolveConfiguredSecret(
                envPassword,
                foundry.password,
                'foundry.password',
            );
            const resolvedServiceToken = resolveConfiguredSecret(
                envServiceToken,
                security['service-token'],
                'security.service-token',
            );
            const resolvedAdminPepper = resolveConfiguredSecret(
                envAdminPepper,
                security['admin-pepper'],
                'security.admin-pepper',
            );
            const resolvedSessionKey = resolveConfiguredSecret(
                process.env.APP_FOUNDRY_SESSION_KEY,
                security['foundry-session-key'],
                'security.foundry-session-key',
                true,
            );
            const resolvedPreviousSessionKey = resolveConfiguredSecret(
                process.env.APP_FOUNDRY_SESSION_PREVIOUS_KEY,
                security['foundry-session-previous-key'],
                'security.foundry-session-previous-key',
                true,
            );
            const rateLimit = security['rate-limit'] || {};
            const corsConfig = security.cors || {};
            const adminSecurity = security.admin || {};
            const configuredAdminNetworks = Array.isArray(adminSecurity['allowed-networks'])
                ? adminSecurity['allowed-networks'].map((network: unknown) => String(network).trim()).filter(Boolean)
                : undefined;
            const adminAllowedNetworks = validateAdminAllowedNetworks(
                parseCsv(process.env.APP_ADMIN_ALLOWED_NETWORKS)
                ?? configuredAdminNetworks
                ?? [...DEFAULT_ADMIN_ALLOWED_NETWORKS],
            );
            const configuredAllowedOrigins = Array.isArray(corsConfig['allowed-origins'])
                ? corsConfig['allowed-origins'].map((origin: unknown) => String(origin).trim()).filter(Boolean)
                : undefined;
            const modulePolicy = resolveModulePolicyConfig(security, process.env);

            const sourceGovernanceConfig = security['source-governance'] || {};
            const hostAllowlist = Array.isArray(sourceGovernanceConfig['host-allowlist'])
                ? sourceGovernanceConfig['host-allowlist'].map((host: unknown) => String(host).trim()).filter(Boolean)
                : undefined;

            _cachedConfig = {
                app: {
                    host: appHost,
                    port: appPort,
                    apiPort: app['api-port'],
                    adminOrigin: adminOrigin.origin,
                    protocol: appProtocol,
                    chatHistory: app['chat-history'],
                    version: version,
                    url: appUrl
                },
                foundry: {
                    host: host,
                    port: port,
                    protocol: protocol,
                    url: foundryUrl,
                    username: envUsername || foundry.username,
                    password: resolvedFoundryPassword,
                    userId: foundry.userId,
                    connector: foundry.connector,
                    foundryDataDirectory: foundry.foundryDataDirectory,
                    allowLiveCompendiumUuidFallback:
                        envAllowLiveCompendiumUuidFallback
                        ?? foundry.allowLiveCompendiumUuidFallback
                        ?? foundry['allow-live-compendium-uuid-fallback']
                        ?? false,
                },
                debug: {
                    enabled: debug.enabled ?? false,
                    level: debug.level ?? 1
                },
                security: {
                    rateLimit: {
                        enabled: rateLimit.enabled ?? true,
                        windowMinutes: rateLimit['window-minutes'] ?? 15,
                        maxAttempts: rateLimit['max-attempts'] ?? 5,
                    },
                    bodyLimit: security['body-limit'] ?? '10mb',
                    serviceToken: resolvedServiceToken,
                    adminPepper: resolvedAdminPepper,
                    foundrySessionKey: resolvedSessionKey,
                    foundrySessionPreviousKey: resolvedPreviousSessionKey,
                    adminAllowedNetworks,
                    modulePolicy,
                    sourceGovernance: {
                        hostAllowlist
                    },
                    cors: {
                        allowAllOrigins: envCorsAllowAllOrigins ?? corsConfig['allow-all-origins'] ?? false,
                        allowedOrigins: envCorsAllowedOrigins || configuredAllowedOrigins || [appUrl]
                    }
                }
            };
            return _cachedConfig;
        }
    } catch (e) {
        let configLocation = '<unknown>';
        try { configLocation = getConfigFilePath(); } catch { /* paths not initialized */ }
        logger.error(`\n\x1b[31m[Config] Error: settings.yaml not found or invalid at ${configLocation}.\x1b[0m`);
        logger.error(`[Config] Run 'npm run setup' or provide --data-dir to specify the data directory.`);
        if (typeof process !== 'undefined' && process.exit) {
            process.exit(1);
        }
    }
    return null;
}

/**
 * Get config synchronously (requires config to be loaded first)
 * For use in API routes after initial load
 */
export function getConfig(): AppConfig {
    if (!_cachedConfig) {
        throw new Error('Config not loaded. Call loadConfig() first.');
    }
    return _cachedConfig;
}
