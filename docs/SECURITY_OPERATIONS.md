# Security Operations

This runbook covers the local operator actions introduced by ADR-0033 Phases 3
and 4.
All paths are relative to the configured `<DATA_DIR>` unless stated otherwise.
For setting purpose, defaults, and required/optional status, see
[`CONFIGURATION.md`](CONFIGURATION.md).

## External Secrets

The Foundry service-account username and secret-bearing settings accept
exactly one structured reference:

```yaml
foundry:
    username: { env: FOUNDRY_USERNAME }
    password: { env: FOUNDRY_PASSWORD }

security:
    service-token: { env: APP_SERVICE_TOKEN }
    admin-pepper: { file: /run/secrets/sheet-delver-admin-pepper }
    foundry-session-key: { file: /run/secrets/sheet-delver-session-key }
```

Environment references must name a populated variable. File references must be
absolute, regular non-symlink files no larger than 16 KiB. On POSIX systems,
file mode must deny all group/other access, for example `0600`. A Foundry
session-key file must be outside `<DATA_DIR>` so copying the data directory does
not also copy the decryption key.

Legacy inline values still load with an operator warning to permit migration.
Move each value to its secret provider, replace it with a structured reference,
restart, and confirm the warning is gone. The legacy `admin-setup-token` setting
and `APP_ADMIN_SETUP_TOKEN` are ignored and should be removed.

## Admin Origin And Sessions

The application runs one Next.js shell and one Core Service. Configure the
local browser URL that may expose the admin route group:

```yaml
app:
    admin-origin: https://sheetdelver.internal.example

security:
    admin:
        allowed-networks:
            - 127.0.0.0/8
            - ::1/128
            - 192.168.1.0/24
```

`APP_ADMIN_ORIGIN` and comma-separated `APP_ADMIN_ALLOWED_NETWORKS` override
those settings. The origin must contain only HTTP(S) scheme, hostname, and an
optional port. CIDRs are validated during startup and an empty list is rejected.

The shell serves `/admin` and proxies `/api/admin` only when the request `Host`
matches the configured origin. Other local or external hostnames receive `404`.
Core also checks browser `Origin`/`Referer` and the effective client address.
The reverse proxy must preserve `Host`, overwrite rather than trust a
client-supplied `X-Forwarded-For`, and keep the application listener off the
public network. Do not publish the local admin hostname through an external
tunnel. Host matching is routing policy; the CIDR/firewall rule is the network
security boundary.

Admin browser sessions are in-memory, revocable, and valid for 15 minutes. The
opaque credential is held only in an HttpOnly, SameSite=Strict cookie scoped to
`/api/admin`; `Secure` follows the configured admin origin's HTTPS scheme.
Browser code retains only the CSRF token in module memory. Restart
revokes all admin sessions. On the first Phase 3 admin load, the exact legacy
`admin-token` and `admin-csrf` local-storage entries are removed without reading
or clearing unrelated preferences.

### Development-Only Lockout Exception

`npm run dev` explicitly runs Core and the shell with `NODE_ENV=development`.
In that operator-controlled mode, admin setup/login/reset requests are not
rate-limited and failed admin passwords do not increment or honor the persisted
account lockout. `npm start` explicitly uses `NODE_ENV=production` and retains
both protections. An unset or unrecognized `NODE_ENV` also retains them; only
explicit development bypasses the controls. This distinction does not change
the 15-minute lifetime of a successful admin session or the player-login rate
limiter. Do not expose a development process to an untrusted network: password
verification still runs, but brute-force throttling and lockout do not.

## Bootstrap And Recovery

When no admin account exists, issue a bootstrap credential from the local
console:

```bash
npm run admin:bootstrap -- --data-dir=<DATA_DIR>
```

It is valid for 60 minutes and only for account creation. Issuing another
bootstrap credential replaces the previous one. The stored file contains a
salted digest, not the displayed credential; success or expiry consumes it.

When an admin account already exists, issue a recovery credential:

```bash
npm run admin:recover -- --data-dir=<DATA_DIR>
```

It is valid for 10 minutes and only for password reset. A successful reset
revokes every active admin session. Wrong guesses do not consume an otherwise
valid bootstrap or recovery credential.

## Foundry Session Encryption

Cross-restart Foundry user sessions use one installation key to encrypt the
map of independent browser/Foundry session records. An explicit
`APP_FOUNDRY_SESSION_KEY` or resolved `security.foundry-session-key` takes
priority. The value must decode to exactly 32 bytes and use an explicit prefix:

```bash
printf 'base64:'; openssl rand -base64 32 | tr -d '\n'; printf '\n'
```

The encrypted AES-256-GCM envelope is written atomically with owner-only mode at
`<DATA_DIR>/security/foundry-sessions.enc.json`. It contains a key identifier,
IV, authentication tag, and ciphertext, never plaintext cookies.

When no explicit current or previous key is configured, Core creates and reuses
an owner-only automatic key at
`$XDG_CONFIG_HOME/sheet-delver/foundry-session.key`, or
`~/.config/sheet-delver/foundry-session.key` when `XDG_CONFIG_HOME` is unset.
This path is outside `<DATA_DIR>` and does not require changing `settings.yaml`.
Back up the key separately from the data directory if cross-host restoration is
required. Startup resolves parent symlinks before enforcing this separation, so
an `XDG_CONFIG_HOME` symlink cannot place the key physically inside
`<DATA_DIR>`.

At first startup with either an explicit or automatic key, the old
`<DATA_DIR>/cache/core/sessions.json` is encrypted and then removed. If no key
can be created or loaded, startup reports the failure. Core never replaces a
missing automatic key while an encrypted envelope exists; restore that key or
configure a matching explicit current/previous key.

## Key Rotation

1. Preserve current key A in the secret provider.
2. Generate key B and set B as `APP_FOUNDRY_SESSION_KEY`.
3. Set A as `APP_FOUNDRY_SESSION_PREVIOUS_KEY`.
4. Restart. A successful load with A immediately rewrites the envelope with B
   and logs that re-encryption completed.
5. Confirm restoration and the re-encryption log, then remove the previous-key
   setting and retire A.

Do not remove A before one successful load. A previous key without a current
key is rejected at startup. Both keys use the same explicit encoding rules.

## Rollback And Loss Of Key

A pre-Phase-3 binary cannot read the encrypted envelope. Rolling code back may
recreate plaintext persistence and is therefore a security regression; retain
the encrypted file, restore Phase 3 code, and re-authenticate users instead.

If neither configured key matches the envelope, startup fails rather than
discarding or silently accepting session data. Restore the matching key. If the
key is permanently lost, move or delete only
`<DATA_DIR>/security/foundry-sessions.enc.json` during an intentional maintenance
window and have users log in again. Do not place a replacement key under
`<DATA_DIR>` merely to make startup succeed.

For an application rollback that must proceed, disable persistence, preserve a
copy of the encrypted envelope outside the running data directory, and require
fresh Foundry logins. Never convert the encrypted envelope back to plaintext.

## Credential Rotation Checklist

- Rotate the Foundry account password in Foundry and its external secret
  provider together, then restart and verify the Core account login.
- Rotate the service token in its external secret provider and every trusted
  server-side caller; it is never a browser credential.
- Rotate the optional admin pepper only together with an admin password reset,
  because changing it invalidates the stored password verifier.
- Use the recovery flow to rotate the admin password; all admin sessions are
  revoked automatically.
- Use the current/previous procedure above for session encryption keys.

After migration or rotation, verify player login/restoration, admin login and
logout, host/origin/network denial outside the local admin policy, and absence of reusable
secrets in `<DATA_DIR>/config/settings.yaml` and plaintext session caches.

## Request And Realtime Diagnostics

Every Core HTTP request receives a server-generated UUID returned through
`X-Request-ID`. When the browser reports a stable `internal-error`,
`invalid-json`, or `request-body-too-large` code, use that ID to find the
corresponding Core log entry. HTTP 500 logs contain a bounded response type/code
summary and query-free path; raw exception response bodies, credentials, and
upstream payloads are not echoed to the client.

Credential and telemetry requests use smaller JSON limits than document
mutation routes: player login is 8 KiB, admin setup/login/recovery is 16 KiB,
and module UI-health is 4 KiB. A rejection at these boundaries occurs before
the route invokes Foundry session creation, admin credential verification, or
module lifecycle mutation.

Guest Socket.IO clients receive only the public status projection. Authenticated
clients receive the private projection after server-side session restoration.
Socket payloads are limited to 256 KiB and connection attempts to 30 per
effective client address per minute. Core trusts a forwarded socket address
only when the immediate peer is the loopback shell proxy. Repeated
`App Socket | Connection rate limit exceeded` warnings therefore identify the
effective client address selected by that policy.
