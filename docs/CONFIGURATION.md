# Configuration Reference

Sheet Delver reads application configuration from
`<DATA_DIR>/config/settings.yaml`. This document describes the supported
settings, their defaults, and the environment variables used by normal
startup. Security procedures and key rotation are covered separately in
[`SECURITY_OPERATIONS.md`](SECURITY_OPERATIONS.md).

## Loading And Precedence

Normal `npm run dev`, `npm run build`, and `npm start` commands load a
project-root `.env` before starting Core or the application shell. Variables
already present in the process environment take precedence over `.env`.
Environment overrides then take precedence over `settings.yaml`, followed by
the defaults listed below.

The data directory is selected in this order:

1. `--data-dir=/absolute/or/relative/path`
2. `SHEET_DELVER_DATA`
3. `DATA_DIR` or `USER_DATA` compatibility aliases
4. Existing `./data`
5. Existing `~/.sheet-delver`
6. A newly created `./data`

Keep `.env` and `<DATA_DIR>/config/settings.yaml` owner-only (`0600` on
POSIX). Never expose server variables through `NEXT_PUBLIC_*` names.

## Reference Values

The Foundry username and secret-bearing settings accept either an inline
string or one structured reference:

```yaml
username: { env: FOUNDRY_USERNAME }
password: { file: /run/secrets/foundry-password }
```

Environment references must resolve to a populated variable. File references
must be absolute paths to regular, non-symlink files no larger than 16 KiB;
on POSIX they cannot grant group or other permissions. Inline usernames remain
supported for compatibility. Inline secret values remain migration-only and
produce an operator warning.

## Application Settings

| Setting | Required/default | Purpose |
| --- | --- | --- |
| `app.host` | Required; manager fallback `localhost` | Bind hostname used by the application shell and to construct its browser origin. |
| `app.port` | Required; manager fallback `3000` | Application shell HTTP port. |
| `app.api-port` | Required; manager fallback `3001` | Loopback Core Service port used by the shell proxy. Keep it separate from `app.port`. |
| `app.protocol` | Required; manager fallback `http` | Browser-facing `http` or `https` scheme. TLS may terminate at a reverse proxy. |
| `app.admin-origin` | Optional; defaults to the application origin | Exact local browser origin allowed to expose `/admin` and proxy `/api/admin`. Override with `APP_ADMIN_ORIGIN`. |
| `app.chat-history` | Optional; default `100` | Maximum chat messages returned when a request does not provide its own valid limit. |

`app.admin-origin` is a routing restriction, not the network boundary. Pair it
with `security.admin.allowed-networks`, a correctly configured reverse proxy,
and firewall policy.

## Foundry Connection

| Setting | Required/default | Purpose |
| --- | --- | --- |
| `foundry.host` | Required | Foundry hostname. Override with `FOUNDRY_HOST`. |
| `foundry.port` | Required | Foundry HTTP(S) port. Override with `FOUNDRY_PORT`. |
| `foundry.protocol` | Required | Foundry `http` or `https` scheme. Override with `FOUNDRY_PROTOCOL`. |
| `foundry.url` | Optional | Explicit endpoint retained for compatibility. `FOUNDRY_URL` has highest endpoint priority. Prefer host, port, and protocol for ordinary configuration. |
| `foundry.connector` | Recommended value `socket` | Selects the supported headless Socket.IO connection path. |
| `foundry.username` | Operationally required | Foundry service-account name used by Core. Accepts inline, `{ env }`, or `{ file }`; `FOUNDRY_USERNAME` directly overrides it. |
| `foundry.password` | Conditional | Service-account password. Omit only when that Foundry user has no password. Accepts inline, `{ env }`, or `{ file }`; `FOUNDRY_PASSWORD` directly overrides it. |
| `foundry.userId` | Optional compatibility field | Normally omit. Core resolves the service-account document ID from the configured username. |
| `foundry.foundryDataDirectory` | Optional | Local Foundry data path used by administrative import tooling when both applications can access the same filesystem. |
| `foundry.allow-live-compendium-uuid-fallback` | Optional; default `false` | Diagnostic fallback for unresolved compendium UUIDs. Keep disabled so missing declarations are visible. Override with `APP_ALLOW_LIVE_COMPENDIUM_UUID_FALLBACK`. |

`FOUNDRY_HOST`, `FOUNDRY_PORT`, and `FOUNDRY_PROTOCOL` override their
individual settings. `FOUNDRY_URL` overrides the final connection endpoint,
but host, port, and protocol must still be valid because other configuration
and diagnostics use them.

## Debug Settings

| Setting | Required/default | Purpose |
| --- | --- | --- |
| `debug.enabled` | Optional; default `false` | Enables debug-only HTTP routes and additional diagnostics. Disable outside active troubleshooting. |
| `debug.level` | Optional; default `1` | Logging threshold: `0` none, `1` error, `2` warning, `3` information, `4` debug. Level 4 also installs fatal process error handlers. |

## Security Settings

### Credentials And Keys

| Setting | Required/default | Purpose |
| --- | --- | --- |
| `security.service-token` | Optional | Authenticates trusted server-to-server privileged API requests. It is never sent to browsers and does not affect player or admin login. If omitted, service-token bearer authentication is unavailable. Override with `APP_SERVICE_TOKEN`. |
| `security.admin-pepper` | Optional | Adds a deployment-held secret to the stored admin password verifier. Changing or removing it prevents the existing verifier from matching; use admin recovery to reset the password when rotating it. Override with `APP_ADMIN_PEPPER`. |
| `security.foundry-session-key` | Optional explicit override | Encrypts persisted Foundry user-session cookies with AES-256-GCM. It must decode to exactly 32 bytes with a `base64:` or `hex:` prefix. If omitted, Core creates an owner-only host key outside `<DATA_DIR>`. Override with `APP_FOUNDRY_SESSION_KEY`. |
| `security.foundry-session-previous-key` | Optional; rotation only | Allows one previous session key to decrypt and immediately re-encrypt existing sessions during rotation. It requires a current key and should be removed after successful rotation. Override with `APP_FOUNDRY_SESSION_PREVIOUS_KEY`. |

The automatic session key is stored under
`$XDG_CONFIG_HOME/sheet-delver/foundry-session.key`, or
`~/.config/sheet-delver/foundry-session.key` when `XDG_CONFIG_HOME` is unset.
It is separate from the Foundry password: losing it invalidates only persisted
Sheet Delver-to-Foundry sessions, requiring users to log in again.

`security.admin-setup-token` and `APP_ADMIN_SETUP_TOKEN` are obsolete and
ignored. Use `npm run admin:bootstrap` or `npm run admin:recover` instead.

### Request Policy

| Setting | Required/default | Purpose |
| --- | --- | --- |
| `security.rate-limit.enabled` | Optional; default `true` | Enables player-login rate limiting. Admin login has additional controls described in the security runbook. |
| `security.rate-limit.window-minutes` | Optional; default `15` | Player-login rate-limit window. |
| `security.rate-limit.max-attempts` | Optional; default `5` | Maximum player-login attempts in one window. |
| `security.body-limit` | Optional; default `10mb` | Upper JSON-body ceiling. Sensitive routes impose smaller route-specific limits. |
| `security.cors.allow-all-origins` | Optional; default `false` | Explicitly permits every browser origin. Avoid in normal deployments. Override with `APP_CORS_ALLOW_ALL_ORIGINS`. |
| `security.cors.allowed-origins` | Optional; defaults to the application origin | Browser origins accepted by Express and Socket.IO. Override with comma-separated `APP_CORS_ALLOWED_ORIGINS`. |
| `security.admin.allowed-networks` | Optional; defaults to loopback CIDRs | IPv4/IPv6 CIDRs permitted to reach admin APIs. An explicitly empty or malformed list fails startup. Override with comma-separated `APP_ADMIN_ALLOWED_NETWORKS`. |

### Module Policy

These settings govern lifecycle decisions for locally available module
artifacts. They do not implement remote distribution.

| Setting | Required/default | Purpose |
| --- | --- | --- |
| `security.module-policy.minimum-trust-tier` | Optional; production `verified-third-party`, otherwise `unverified` | Lowest accepted tier: `first-party`, `verified-third-party`, or `unverified`. Override with `APP_MODULE_POLICY_MINIMUM_TRUST_TIER`. |
| `security.module-policy.allow-unverified-in-development` | Optional; `true` outside production | Allows unverified artifacts only in development policy. Override with `APP_MODULE_POLICY_ALLOW_UNVERIFIED_IN_DEVELOPMENT`. |
| `security.module-policy.require-admin-override-for-lower-trust` | Optional; `true` in production | Requires an explicit admin override below the configured trust floor. Override with `APP_MODULE_POLICY_REQUIRE_ADMIN_OVERRIDE_FOR_LOWER_TRUST`. |
| `security.module-policy.require-permission-escalation-approval` | Optional; default `true` | Requires approval when an upgrade requests additional module permissions. Override with `APP_MODULE_POLICY_REQUIRE_PERMISSION_ESCALATION_APPROVAL`. |
| `security.source-governance.host-allowlist` | Reserved | Parsed for future remote source governance but has no active distribution effect while remote module distribution is unavailable. |

Boolean environment overrides accept `true` or `false`. Invalid values are
ignored in favor of the YAML value or documented default.

## Operational Environment Variables

| Variable | Purpose |
| --- | --- |
| `SHEET_DELVER_DATA` | Preferred data-directory override. |
| `DATA_DIR`, `USER_DATA` | Compatibility aliases for the data directory. |
| `SHEET_DELVER_LOCAL_MODULES` | Optional path to the local development module source tree used during managed build generation. |
| `HOST` | Shell-to-Core proxy hostname; default `127.0.0.1`. The standard manager keeps Core local, so override this only for custom process orchestration. |
| `PORT`, `API_PORT` | Core listener overrides. The manager normally supplies `API_PORT`; direct use is intended for process orchestration. |
| `NODE_ENV` | Security/runtime mode. Standard npm commands set this explicitly; use `npm run dev` or `npm start` rather than inventing another value. |
| `DEBUG` | Legacy narrow diagnostic switch that logs the resolved persistent-cache path when set to any non-empty value. Prefer `debug.enabled` and `debug.level`. |

## Minimal Environment Example

```dotenv
FOUNDRY_USERNAME="service-account-name"
FOUNDRY_PASSWORD="service-account-password"
APP_SERVICE_TOKEN="a-separate-random-server-token"
```

`FOUNDRY_PASSWORD` may be omitted for a passwordless Foundry account.
`APP_SERVICE_TOKEN` may be omitted when no trusted server-side caller uses
privileged bearer authentication. Session encryption needs no environment
entry unless the operator chooses an explicit key instead of the automatic
host key.
