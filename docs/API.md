# API Documentation

The Sheet Delver API exposes Foundry-backed data through the Core Service.
Browser user routes use an HttpOnly player-session cookie. Trusted server-side
callers may use an explicit bearer session credential. Admin routes are
protected by the opaque admin session cookie and CSRF flow.

Examples use abstract ids such as `<moduleId>`, `<actorId>`, and
`example-system`; do not treat them as bundled systems.

---

## Authentication

Browser login sets the `sheet-delver-session` HttpOnly, SameSite=Strict cookie;
the reusable session credential is never returned to browser JavaScript.
Trusted non-browser callers can instead present:

```http
Authorization: Bearer <token>
```

Admin mutation routes require the admin session plus CSRF token handled by the
admin UI client.

Every Core response includes a server-generated `X-Request-ID`. Production
JSON 500 responses use:

```json
{
  "error": "Internal server error",
  "code": "internal-error",
  "requestId": "correlation-uuid"
}
```

Malformed JSON uses `invalid-json`; an oversized request uses
`request-body-too-large`. Intentional 4xx, 501, and 503 endpoint contracts are
not converted to internal errors.

---

## Session And Status

### `GET /api/status`

Auth: try-auth.

Unauthenticated callers receive the public availability projection and a
minimum login roster: display name, active state, and server-decided login
eligibility only. It omits user/world identifiers, roles, actor links, avatars,
Foundry URL, private world content, and debug configuration.

Authenticated callers receive connection, world, current-user, and readiness
status. `initialized: true` means world bootstrap has completed, including
module discovery, compendium indexing/hydration, and primary document cache
seeding.

```json
{
  "connected": true,
  "isAuthenticated": true,
  "currentUserId": "user-id",
  "initialized": true,
  "users": [
    {
      "_id": "user-id",
      "name": "User",
      "role": 4,
      "isGM": true,
      "active": true,
      "img": "path/or/url"
    }
  ],
  "system": {
    "id": "example-system",
    "status": "active",
    "worldTitle": "Example World"
  },
  "url": "http://foundry.example",
  "appVersion": "0.10.0"
}
```

### `POST /api/login`

Body:

```json
{ "username": "User", "password": "password" }
```

Response:

```json
{ "success": true, "userId": "user-id" }
```

The request body is limited to 8 KiB. Usernames are trimmed and bounded to
1-128 characters; passwords are bounded to 1024 characters.

This browser-facing contract is stable across supported Foundry generations.
Core resolves the user id and negotiates Foundry's upstream `/join` payload:
generation 13 and generation 14 through build 365 use `userid`; generation 14
build 366 and later use `username` plus `userId`. The resolved id and
upstream cookie remain server-side.

### `POST /api/logout`

Auth: protected.

Destroys the current user session and closes the user's upstream Foundry
transport.

### `GET /api/system`

Auth: protected.

Returns basic active-system and world information.

### `GET /api/system/data`

Auth: protected.

Returns system data produced by the active adapter. Adapter data is sourced from
the module runtime, not from a broad module-facing client.

---

## Actors

Actor reads have three stages (ADR-0038):

1. Source Actors authorize the requesting Foundry user.
2. The active adapter prepares one deterministic, user-invariant Actor snapshot per
   source revision.
3. Routes project the authorized prepared revision for the requested surface.

A direct read returns `503` when its prepared revision is unavailable. List reads
omit only the unavailable Actor and retain a bounded server diagnostic. Writes
remain source-shaped and are authorized by Foundry; after Foundry acknowledges a
mutation, Core updates the source Actor and publishes its replacement prepared
revision before notifying realtime clients.

### `GET /api/actors`

Auth: protected.

Returns visible non-NPC Actors partitioned into `ownedActors` and
`readOnlyActors`, with `actors` retained as the owned compatibility alias.
OBSERVER and OWNER entries are authorized from source and projected from the
prepared Store. LIMITED visibility contributes only adapter-produced
`actorCards`. Before world and prepared-state bootstrap completes, the route
returns `503`.

### `GET /api/actors/cards`

Auth: protected.

Returns dashboard card projections for visible Actors. Card hooks receive
the same prepared Actor revision used by detail, roll, and initiative reads.
Core fills omitted `name` and `img` from that revision; adapters may supply
system-specific fields and explicit identity presentation overrides.

### `GET /api/actors/:id/card`

Auth: protected.

Returns one authorization-bounded card projection. The source Actor establishes
visibility; the active adapter receives its matching prepared revision. Core
fills omitted `name` and `img` from that revision, matching the bulk-card response.

### `GET /api/actors/:id`

Auth: protected.

Returns the authorized prepared Actor projection used by module and generic
sheets. The response retains the complete source shape and adds canonical
normalized/derived fields, `foundryUrl`, the active adapter `systemId`, and
the actual `foundrySystemId`. Declared hydrated compendium UUID values are
resolved before projection.

### `POST /api/actors`

Auth: protected.

Creates an Actor through the requesting user's Foundry transport.

### `PATCH /api/actors/:id`

Auth: protected.

Updates Actor-level source data using dot notation through the requesting user's
Foundry transport.

### `DELETE /api/actors/:id`

Auth: protected.

Deletes the Actor through the requesting user's Foundry transport. Foundry is
the authoritative permission check.

### `POST /api/actors/:id/update`

Auth: protected.

Routes hybrid Actor updates, including supported embedded Item and Active Effect
paths.

### `POST /api/actors/:id/items`

### `PUT /api/actors/:id/items`

### `DELETE /api/actors/:id/items?itemId=<itemId>`

Auth: protected.

Creates, updates, or deletes an embedded Item through the requesting user's
Foundry transport. Embedded acknowledgements rebuild the owning Actor's prepared
revision.

### `POST /api/actors/:id/roll`

Auth: protected.

Executes an adapter-supported roll from the current prepared Actor revision.

Example body:

```json
{ "type": "formula", "key": "1d20+5" }
```

---

## Journals And Shared Content

### `GET /api/journals`

Auth: protected.

Returns visible journals and folders.

### `POST /api/journals`

Auth: protected.

Creates a journal entry or folder.

```json
{ "type": "JournalEntry", "data": { "name": "Entry" } }
```

### `GET /api/journals/:id`

Auth: protected.

Returns one visible journal entry.

### `PATCH /api/journals/:id`

Auth: protected.

Updates a journal entry or folder.

### `DELETE /api/journals/:id`

Auth: protected.

Deletes a journal entry or folder. Pass `type=JournalEntry` or `type=Folder`.

### `GET /api/shared-content`

Auth: protected.

Returns the latest media or journal content shared with the current user.

---

## Document UUID Resolution

### `GET /api/foundry/document?uuid=<uuid>`

Auth: protected.

Resolves a Foundry UUID through the platform `DocumentResolver`.

- World primary documents resolve from platform stores after bootstrap.
- Compendium UUIDs resolve from declared hydrated compendium pack rows by
  default.
- Undeclared, non-hydrated, or missing compendium rows return `null` with a
  warning.
- Live Foundry compendium fallback is diagnostics-only and must not be required
  by module code.

---

## Module UI Serving

### `GET /api/modules/:id/ui`

Auth: none.

Serves a managed module's compiled UI artifact from `<DATA_DIR>/modules/:id` as
browser-compatible ESM. The server reads the artifact manifest, loads the UI
entry, rewrites bare SDK/React imports to host browser globals, and returns
JavaScript with `Cache-Control: no-store`.

This route is for managed artifacts. Local dev UI source under
`<DATA_DIR>/local/modules` is bundled through the generated
`.managed/module-ui-registry.ts`.

Returns `404` when the module or UI artifact is missing.

Module IDs use one canonical lowercase ASCII slug grammar throughout routing,
registry state, runtime lookup, and admin operations. Module and asset files
must be regular files whose lexical and physical paths remain beneath the exact
configured module directory; path-like IDs and symlink escapes are rejected.

### `POST /api/modules/:id/ui-error`

Auth: valid player session.

Records a browser-side module UI import/evaluation failure into lifecycle health.
This is an operational health signal so the admin can see why a module fell back
to the generic UI.

```json
{
  "source": "managed",
  "message": "Failed to load runtime UI manifest"
}
```

The body is limited to 4 KiB. The module must be known, enabled, and active for
the reported `local` or `managed` source. Messages are flattened, stripped of
control characters, bounded to 500 characters, and limited to five reports per
server-side session/module each minute.

### `GET /api/modules/:id/assets/*`

Auth: none.

Serves files from the enabled module's `assets/` directory. Core resolves the
registry-selected source, so local development and managed packages use the same
URL without mixing files between source versions. Disabled or inactive sources
are not used as fallbacks.

---

## Module Registry

These public endpoints are safe to call before user login.

### `GET /api/registry/modules`

Returns manifest metadata for discovered modules.

```json
[
  {
    "id": "example-system",
    "title": "Example System",
    "version": "1.0.0",
    "experimental": false
  }
]
```

### `GET /api/registry/sources`

Returns the active source for each known module.

Source values:

- `"local"`: local dev source under `<DATA_DIR>/local/modules`.
- `"managed"`: installed artifact under `<DATA_DIR>/modules`.

```json
{
  "example-system": "managed"
}
```

The browser uses this map to choose between local bundled UI source and the
managed runtime ESM route. It is cached until module lifecycle events invalidate
the module source cache.

---

## Module API Routes

Module-authored server routes are mounted under:

```text
/api/modules/:moduleId/*
```

The route table and behavior are defined by the module's `module/server.ts`.
Module handlers receive a `ModuleServerRequest` with `req.runtime` as the only
document, roll, table, and chat surface. `req.runtime.documents` is intentionally
source-shaped and user-authorized; it does not expose the shared prepared Actor
Store. Standard card, detail, roll, and initiative behavior should use the
platform Actor routes and adapter hooks so every consumer receives the same
prepared revision.

Module routes should use SDK response helpers from `@sheet-delver/sdk/server`:

```ts
import { json, error, type ModuleRouteTable } from '@sheet-delver/sdk/server';

export const apiRoutes: ModuleRouteTable = {
    'actors/[id]/action': async (req, params) => {
        const { route } = await params.params;
        const actorId = route[1];
        const actor = await req.runtime.documents.get('Actor', actorId);
        if (!actor) return error('not_found', 'Actor not found');
        return json({ actor });
    },
};
```

Writes through `req.runtime.documents`, `req.runtime.chat`, `req.runtime.rolls`,
and `req.runtime.tables` are bound to the requesting Foundry user.

---

## Admin API

The browser-facing admin UI calls these through the application shell's
`/api/admin/...` proxy. The shell exposes `/admin` and `/api/admin` only when the
request host matches `app.admin-origin`; other hostnames receive `404`. The
backend Core Service mounts the routes at `/admin/...` and independently
requires the configured browser origin and an allowed client network.

Browser login/setup sets the opaque `sheet-delver-admin-session` HttpOnly,
SameSite=Strict cookie scoped to `/api/admin`. Response JSON contains the CSRF
token but never the session credential. Trusted allowed-network CLI clients may
present an opaque active session through `Authorization: Bearer`.

### `GET /admin/auth/status`

Returns whether an admin account exists.

### `POST /admin/auth/setup`

Creates the first admin account using `{ bootstrapToken, password }`. Generate
the single-use, 60-minute bootstrap credential locally with
`npm run admin:bootstrap -- --data-dir=<DATA_DIR>`.

Admin setup, login, and recovery request bodies are limited to 16 KiB.
Passwords are bounded to 1024 characters and one-time credentials to 256
characters.

### `POST /admin/auth/login`

Authenticates with `{ password }`, sets the opaque session cookie, and returns
the admin identity, CSRF token, and expiration interval.

### `POST /admin/auth/reset`

Resets the admin password using `{ recoveryToken, newPassword }` and revokes all
active admin sessions. Generate the single-use, 10-minute recovery credential
locally with `npm run admin:recover -- --data-dir=<DATA_DIR>`.

### `POST /admin/auth/logout`

Requires the active cookie and CSRF header, revokes the server-side session,
and expires the browser cookie.

### `GET /admin/auth/me`

Returns the authenticated admin identity and the current CSRF token. It never
returns the opaque session credential.

### `GET /admin/status`

Returns Core Service and world status for the admin UI.

### `POST /admin/world/launch`

Launches a world from setup.

```json
{ "worldId": "world-id" }
```

### `POST /admin/world/shutdown`

Shuts down the active world.

### `GET /admin/audit`

Returns recent admin audit events.

---

## Module Lifecycle Admin

### `GET /admin/lifecycle`

Returns lifecycle state for discovered modules.

```json
{
  "success": true,
  "modules": [
    {
      "moduleId": "example-system",
      "title": "Example System",
      "enabled": true,
      "status": "validated",
      "experimental": false,
      "managed": true,
      "activeSource": "managed",
      "localDirectory": "/path/to/<DATA_DIR>/local/modules/example-system",
      "localEnabled": false,
      "managedEnabled": true,
      "sourceStates": {
        "managed": {
          "status": "validated",
          "enabled": true,
          "validation": {
            "manifestValid": true,
            "diagnostics": []
          }
        }
      },
      "health": {
        "errorCount": 0,
        "lastError": "",
        "lastErrorAt": 0
      },
      "artifact": {
        "version": "1.0.0",
        "source": "index://source-id",
        "installedAt": 1746000000000
      }
    }
  ]
}
```

`localEnabled` and `managedEnabled` preserve independent enablement state when a
module has both local dev source and a managed install.

### `POST /admin/lifecycle/:moduleId/enable`

Enables a module or a specific source card. Requires admin auth and CSRF.

### `POST /admin/lifecycle/:moduleId/disable`

Disables a module or a specific source card. Requires admin auth and CSRF.

### `POST /admin/lifecycle/:moduleId/switch-source`

Switches between local dev source and managed install when both exist.

```json
{ "source": "managed" }
```

`source` must be `"local"` or `"managed"`.

On success, the server updates lifecycle state, refreshes the registry, and
broadcasts `moduleSourceChanged`.

---

## Module Manager Admin

These routes are authenticated, CSRF-protected, and audited.

### Local archive operations

An administrator can preview or apply a packaged `.tgz` through the same
validation and transaction used by managed modules:

```text
POST /admin/manager/:moduleId/archive/dry-run/install
POST /admin/manager/:moduleId/archive/install
POST /admin/manager/:moduleId/archive/dry-run/upgrade
POST /admin/manager/:moduleId/archive/upgrade
```

Send the archive bytes as `application/gzip`, `application/x-gzip`, or
`application/octet-stream`. Uploads are limited to 64 MiB and are removed from
staging after the request. Optional query parameters are:

- `trustTier=first-party|verified-third-party|unverified`
- `approveTrustOverride=true|false`
- `approvePermissionEscalation=true|false`

The default trust tier for an operator-supplied archive is `unverified`.
Production policy therefore requires an explicit lower-trust override unless
the administrator assigns a tier accepted by local policy. Dry runs return
archive limits, computed SHA-256 integrity, compatibility and governance
results, blockers, and whether a same-ID local development source exists.

Every successful operation installs only to
`<DATA_DIR>/modules/<moduleId>`. Archive operations never write, replace, or
delete `<DATA_DIR>/local/modules`, and they do not switch the active source when
a local development copy is selected.

The equivalent host CLI is:

```bash
npm run module:archive -- dry-run-install /path/to/my-system-1.2.0.tgz
npm run module:archive -- install /path/to/my-system-1.2.0.tgz --approve-trust-override
npm run module:archive -- dry-run-upgrade /path/to/my-system-1.3.0.tgz
npm run module:archive -- upgrade /path/to/my-system-1.3.0.tgz --approve-permission-escalation
```

Use `--data-dir <path>`, `--module-id <id>`, `--manifest <path>`, and
`--trust-tier <tier>` as needed. Supplying a release manifest additionally
requires the uploaded bytes and archive `info.json` to match its digest, size,
module identity, compatibility, permissions, dependencies, and conflicts.

### Public release operations

An administrator can preview or apply a public release manifest:

```text
POST /admin/manager/:moduleId/release/dry-run/install
POST /admin/manager/:moduleId/release/install
POST /admin/manager/:moduleId/release/dry-run/upgrade
POST /admin/manager/:moduleId/release/upgrade
```

Send JSON containing exactly one source:

```json
{
  "manifestUrl": "https://example.org/releases/v1.2.0/sheet-delver-manifest.json",
  "approveTrustOverride": true,
  "approvePermissionEscalation": false,
  "approveDowngrade": false
}
```

Or use a public GitHub repository shortcut:

```json
{
  "repository": "https://github.com/example/my-system"
}
```

The shortcut resolves the conventional
`releases/latest/download/sheet-delver-manifest.json` asset. Direct public
releases default to `unverified`; clients cannot assign their own trust tier.
Every source and redirect host must match
`security.source-governance.host-allowlist`. The client permits HTTPS only,
rejects non-public destination addresses, applies bounded redirects, retries,
timeouts, and response sizes, and verifies archive size and SHA-256 before the
local archive transaction runs.

Successful public release operations install only to
`<DATA_DIR>/modules/<moduleId>`. They never write to
`<DATA_DIR>/local/modules` or silently change an active local source.
Replacing an installed release with an earlier version requires
`approveDowngrade: true`; the server enforces this independently of the admin UI.

### `POST /admin/manager/:moduleId/install`

Installs a discovered local module under manager policy. Public catalog,
release-manifest, and archive installs use their dedicated endpoints above.
Arbitrary `index://` and HTTP(S) inputs remain disabled here.

### `POST /admin/manager/:moduleId/upgrade`

Upgrades a managed module under trust, verification, and permission-escalation
policy.

### `POST /admin/manager/:moduleId/uninstall`

Uninstalls a managed module and removes persisted artifact metadata.

### `POST /admin/manager/:moduleId/validate`

Re-runs manifest, compatibility, and managed artifact health checks.

### Module update policy

```text
GET /admin/manager/:moduleId/update-policy
PUT /admin/manager/:moduleId/update-policy
```

The update body accepts `locked` and/or `pinnedVersion`. Set
`pinnedVersion` to `null` to clear a pin. A pin permits only an upgrade whose
target exactly matches that version. A lock prevents both upgrades and
uninstall. Catalog installs record their `sourceProfileId` in local artifact
metadata; a later upgrade still names its selected source explicitly.

Manager policy errors use structured `errorCode` values, including:

- `trust-policy-blocked`
- `artifact-verification-failed`
- `permission-escalation-requires-approval`
- `update-policy-blocked`
- `validation-failed`
- `module-not-found`

---

## Source Profiles

Source profiles configure credential-free public catalogs:

```text
GET    /admin/sources
POST   /admin/sources
PUT    /admin/sources/:id
DELETE /admin/sources/:id
POST   /admin/sources/:id/test
GET    /admin/sources/:id/modules
GET    /admin/catalog?refresh=true
GET    /admin/sources/:sourceId/modules/:moduleId/release?version=1.2.0
```

Custom source creation accepts `name`, `baseUrl`, optional `enabled`, and
optional non-negative `priority`. The URL must use HTTPS, contain no credentials,
and match the configured host allowlist. Authentication, source kind, and trust
tier are not accepted from clients. Custom catalogs are always `unverified`.
The built-in official source is first-party; its identity and URL cannot be
changed or deleted, though it can be disabled or reprioritized.

Catalog results expose `fresh`, `cached`, `stale`, or `error` source states.
Stale data remains available for discovery after a refresh failure. Duplicate
module IDs include the selected source and all lower-priority alternatives;
source priority never silently rewrites an installed module.

Install or upgrade a specific catalog entry with:

```text
POST /admin/sources/:sourceId/modules/:moduleId/dry-run/install
POST /admin/sources/:sourceId/modules/:moduleId/install
POST /admin/sources/:sourceId/modules/:moduleId/dry-run/upgrade
POST /admin/sources/:sourceId/modules/:moduleId/upgrade
```

The JSON body may contain `version`, `approveTrustOverride`,
`approvePermissionEscalation`, and `approveDowngrade`. The release inspection
response lists only versions compatible with the running Sheet Delver core and
SDK contracts. Omitting `version` selects the newest compatible release. The
server resolves the selected immutable manifest from validated module-owned
history; clients cannot substitute an archive URL or trust tier. A missing or
invalid history asset falls back to the compatible latest release only.

The generic manager's `index://` and arbitrary HTTP(S) source references remain
disabled with `remote-module-distribution-disabled`. Public network acquisition
is available only through validated catalogs or the bounded release-manifest
operations above.

---

## Dependencies And Conflicts

Module manifests can declare dependencies and conflicts:

```json
{
  "id": "example-system",
  "title": "Example System",
  "dependencies": ["required-module-id"],
  "conflicts": ["conflicting-module-id"]
}
```

Enable validates dependencies and conflicts before changing lifecycle state.
Disable rejects when another enabled module depends on the target.
