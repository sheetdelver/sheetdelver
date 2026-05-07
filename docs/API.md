# API Documentation

The Sheet Delver API provides access to Foundry VTT data through a headless session wrapper.

## Authentication
All protected routes require a `Bearer` token in the `Authorization` header.
Tokens are obtained via `/api/login`.

---

## Session & Status

### `GET /api/status`
**Auth**: Try-Auth (Aggregates system + user state)
Returns the current connection status, world metadata, and active user list.

**Response:**
```json
{
  "connected": true,
  "isAuthenticated": true,
  "currentUserId": "...",
  "initialized": true,
  "users": [
    {
      "_id": "...",
      "name": "Gamemaster",
      "curor": "...",
      "role": 4,
      "isGM": true,
      "active": true,
      "img": "..."
    }
  ],
  "system": {
    "id": "shadowdark",
    "status": "active",
    "worldTitle": "...",
    "actorSyncToken": 1739634420,
    "config": { ... }
  },
  "url": "http://foundryServer:30000",
  "appVersion": "0.5.0"
}
```

### `POST /api/login`
**Body**: `{ "username": "...", "password": "..." }`
**Response**: `{ "success": true, "token": "uuid", "userId": "uuid" }`

### `POST /api/logout`
**Auth**: Protected
Destroys the current user session and closes their dedicated socket.

### `GET /api/system`
**Auth**: Protected
Returns basic system information (id, version, world title).

### `GET /api/system/data`
**Auth**: Protected
Returns full system-specific data (ancestries, classes, etc.) adapted from the world.

---

## Actors & Items

### `GET /api/actors`
**Auth**: Protected
Returns actors visible to the current user, separated into `ownedActors` and `readOnlyActors`.

### `GET /api/actors/:id`
**Auth**: Protected
Returns fully normalized actor data. Automatically resolves UUIDs, handles name resolution via the Compendium Cache, and includes system-specific computed data (e.g. slots, AC).

### `PATCH /api/actors/:id`
**Auth**: Protected
Updates actor-level data using dot notation.

### `POST /api/actors/:id/update`
**Auth**: Protected
**Hybrid Update**: Routes updates to either the actor or specific embedded items based on the provided paths (e.g., `items.ID.system.equipped`).

### `POST /api/actors/:id/roll`
**Auth**: Protected
**Body**: 
- `{ "type": "ability", "key": "str" }`
- `{ "type": "formula", "key": "1d20+5" }`
- `{ "type": "use-item", "key": "itemId" }`

---

## Journals & Shared Content

### `GET /api/journals`
**Auth**: Protected
Returns a hierarchical list of journals and folders visible to the user.
**Response**: `{ "journals": [...], "folders": [...] }`

### `POST /api/journals`
**Auth**: Protected
Creates a new journal entry or folder.
**Body**: `{ "type": "JournalEntry" | "Folder", "data": { ... } }`

### `GET /api/journals/:id`
**Auth**: Protected
Returns detailed data for a specific journal entry.

### `PATCH /api/journals/:id`
**Auth**: Protected
Updates an existing journal entry or folder.
**Body**: `{ "type": "JournalEntry" | "Folder", "data": { ... } }`

### `DELETE /api/journals/:id`
**Auth**: Protected
Deletes a journal entry or folder.
**Query**: `type=JournalEntry` or `type=Folder`

### `GET /api/shared-content`
**Auth**: Protected
Returns the latest media or journal shared by the GM with the current user.

### `GET /api/foundry/document?uuid=...`
**Auth**: Protected
Fetches any document (Actor, Item, Journal, Scene) by its universal UUID.

---

## Module UI Serving (Public)

### `GET /api/modules/:id/ui`
No authentication required. Serves the compiled UI artifact for a managed module as raw ESM JavaScript.

This endpoint is the runtime fallback used by `getUIModule()` when a module was installed after the current Next.js build and is therefore absent from the static `module-ui-registry.ts`. The server:
1. Looks up the module's `info.json` for a `manifest.ui` path (falls back to `dist/ui.js`).
2. Reads the compiled artifact and rewrites bare import specifiers to `window.__SD.*` globals:
   - `import { X } from 'react'` → `const { X } = window.__SD.react;`
   - `import { X } from '@sheet-delver/sdk'` → `const { X } = window.__SD.sdk;`
3. Returns the rewritten source with `Content-Type: application/javascript` and `Cache-Control: no-store`.

Returns **404** if the module does not exist or has no UI artifact.

This enables hot-installation of modules at runtime without a rebuild — the browser executes the artifact using the host app's shared React and SDK instances.

---

## Module Registry (Public)

These endpoints require no authentication and are safe to call before a session is established.

### `GET /api/registry/modules`
Returns info metadata for every discovered module (enabled and disabled).

**Response:**
```json
[
  { "id": "dnd5e", "title": "D&D 5e", "version": "0.1.0", "experimental": false },
  { "id": "shadowdark", "title": "Shadowdark System", "version": "1.2.0", "experimental": false }
]
```

### `GET /api/registry/sources`
Returns the active source for every known module.

Source values:
- `"local"` — module is running from `data/local/modules/` (local dev source)
- `"data"` — module is running from `data/modules/` (managed install)
- `"built-in"` — module lives in `src/modules/` (platform-bundled)

**Response:**
```json
{
  "dnd5e": "local",
  "shadowdark": "data"
}
```

This endpoint is consumed by the browser's `getUIModule()` function to pick the correct webpack import alias (`@local-modules` vs `@modules`) when loading a module's UI. It is cached client-side until a `moduleSourceChanged` socket event triggers `invalidateModuleSourceCache()`.

---

## Shadowdark Module Routes
Base URL: `/api/modules/shadowdark`

### `GET /gear/list`
Returns a list of all gear items from the `gear` and `magic-items` compendiums.

### `GET /spells/list`
Returns a list of all spells from the `spells` compendium.

### `GET /effects/predefined-effects`
Returns the system's predefined effects (e.g., "Blind", "Blessed").

### `GET /roll-table`
Lists all available roll tables from the local Shadowdark data packs.

### `GET /roll-table/:id`
Returns detailed table data, including results.

### `POST /roll-table/:id/draw`
Executes a **local draw** using the backend's Math.random logic.
**Body**: `{ "rollMode": "self", "displayChat": true }`

### `GET /actors/:id/level-up/data`
Returns context data for the Level Up wizard (class, ancestry, available talents).

### `POST /actors/:id/level-up/roll-hp`
Rolls HP for the current level.

### `POST /actors/:id/level-up/roll-gold`
Rolls starting gold for a new character.

### `POST /actors/:id/level-up/roll-talent`
Rolls on the class talent table.

### `POST /actors/:id/level-up/roll-boon`
Rolls on the patron boon table.

### `POST /actors/:id/level-up/resolve-choice`
Resolves a nested choice (e.g. Weapon Mastery selection).

### `POST /actors/:id/level-up/finalize`
Assembles and persists level-up changes to the actor.

### `POST /actors/:id/spells/learn`
Adds a spell to the actor's "Known Spells".

---

## Admin API (Localhost Only)

The browser-facing admin UI calls these through the Next.js proxy path `/api/admin/...`.
The backend routes themselves are mounted at `/admin/...` on the Core Service.

### `GET /admin/auth/status`
Returns whether an admin account already exists.

### `POST /admin/auth/setup`
**Body**: `{ "setupToken": "...", "password": "..." }`
Creates the initial admin account and immediately returns an authenticated admin session.

### `POST /admin/auth/login`
**Body**: `{ "password": "..." }`
Authenticates the admin account and returns a short-lived admin session token plus CSRF token.

### `POST /admin/auth/reset`
**Body**: `{ "setupToken": "...", "newPassword": "..." }`
Resets the admin password locally and revokes all active admin sessions.

### `GET /admin/status`
Returns the status of the System Client.

### `POST /admin/world/launch`
**Body**: `{ "worldId": "..." }`
Launches a specific world from setup.

### `POST /admin/world/shutdown`
Shuts down the currently active world.

### `GET /admin/audit`
Returns recent admin audit events (newest first). Requires admin authentication.

**Query Params:**
- `limit` (optional): Max number of events to return, clamped to `1..500` (default `100`).

**Response:**
```json
{
  "success": true,
  "count": 2,
  "events": [
    {
      "eventId": "1c0868ce-3bcd-4cb8-bfa3-0af3a8e0c4d1",
      "timestamp": "2026-04-22T22:08:15.322Z",
      "adminId": "admin",
      "method": "POST",
      "path": "/lifecycle/shadowdark/enable",
      "statusCode": 200,
      "outcome": "success",
      "ip": "127.0.0.1",
      "userAgent": "Mozilla/5.0 ...",
      "durationMs": 34
    }
  ]
}
```

## Module Lifecycle

### `GET /admin/lifecycle`
Returns module lifecycle state for all discovered modules. Requires admin authentication.

**Response:**
```json
{
  "success": true,
  "modules": [
    {
      "moduleId": "dnd5e",
      "title": "D&D 5e",
      "enabled": true,
      "status": "validated",
      "experimental": false,
      "managed": true,
      "reason": null,
      "activeSource": "local",
      "localDirectory": "/path/to/data/local/modules/dnd5e",
      "localEnabled": true,
      "managedEnabled": false,
      "health": {
        "errorCount": 0,
        "lastError": "",
        "lastErrorAt": 0
      },
      "artifact": {
        "version": "0.1.0",
        "source": "index://my-repo",
        "installedAt": 1746000000000
      }
    }
  ]
}
```

`activeSource` is only present when the module has a local dev version alongside a managed install. `localDirectory` contains the path to the local dev copy. `localEnabled` / `managedEnabled` track each source's independently saved enabled state — only one may be `true` at a time.

### `POST /admin/lifecycle/:moduleId/enable`
Enables the target module. Requires admin authentication and a valid admin CSRF token.

If the module has unmet dependencies or conflicts with already-enabled modules, returns **409 Conflict** with violation details.

**Success Response:**
```json
{
  "success": true,
  "message": "Module shadowdark enabled",
  "moduleId": "shadowdark"
}
```

**Conflict Response (409):**
```json
{
  "success": false,
  "error": "Cannot enable module due to dependency or conflict constraints",
  "violations": [
    {
      "type": "unmet-dependency",
      "moduleId": "shadowdark",
      "affectedModule": "generic",
      "reason": "Required dependency \"generic\" is not enabled. Enable it first."
    },
    {
      "type": "conflicting-module",
      "moduleId": "shadowdark",
      "affectedModule": "dnd5e",
      "reason": "Module \"Shadowdark System\" conflicts with enabled module \"D&D 5e System\". Disable it first."
    }
  ]
}
```

### `POST /admin/lifecycle/:moduleId/switch-source`
**Auth**: Admin + CSRF
Switches the active source for a module that has both a local dev version and a managed install present.

**Body:**
```json
{ "source": "local" }
```
`source` must be `"local"` or `"data"`.

On success the server:
1. Updates `activeSource` in the lifecycle store and persists the current source's enabled state.
2. Re-scans the registry so the logic adapter from the new source is used immediately.
3. Emits a `moduleSourceChanged` socket event to all connected clients so they can hot-reload the module UI.

**Response:**
```json
{ "success": true, "moduleId": "dnd5e", "activeSource": "local" }
```

### `POST /admin/lifecycle/:moduleId/disable`
Disables the target module. Requires admin authentication and a valid admin CSRF token.

If other modules depend on this one, returns **409 Conflict** with dependent module details.

**Success Response:**
```json
{
  "success": true,
  "message": "Module shadowdark disabled",
  "moduleId": "shadowdark",
  "reason": "Module disabled by admin"
}
```

**Conflict Response (409):**
```json
{
  "success": false,
  "error": "Cannot disable module because other modules depend on it",
  "violations": [
    {
      "type": "has-dependents",
      "moduleId": "generic",
      "affectedModule": "shadowdark",
      "reason": "Module \"Shadowdark System\" requires \"Generic\" to be enabled. Disable \"Shadowdark System\" first."
    }
  ]
}
```

## Module Manager Operations

These routes are authenticated, CSRF-protected, and audited admin mutation endpoints.

### `POST /admin/manager/:moduleId/install`
Installs a discovered module under manager policy.

**Body:**
```json
{
  "source": "local://shadowdark",
  "version": "1.0.0",
  "integrity": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "signature": "minisign:...",
  "permissions": {
    "network": {
      "outbound": false,
      "allowHosts": []
    },
    "filesystem": {
      "read": ["moduleData"],
      "write": ["moduleData"]
    },
    "adminRoutes": false,
    "sensitiveData": ["actor"]
  }
}
```

**Success Response:**
```json
{
  "success": true,
  "moduleId": "shadowdark",
  "operation": "install",
  "previousStatus": "discovered",
  "newStatus": "validated"
}
```

### `POST /admin/manager/:moduleId/upgrade`
Upgrades a module under trust, verification, and permission-escalation policy.

**Body:**
```json
{
  "source": "https://example.com/modules/shadowdark-2.0.0.tgz",
  "targetVersion": "2.0.0",
  "integrity": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "signature": "minisign:...",
  "permissions": {
    "network": {
      "outbound": true,
      "allowHosts": ["api.example.com"]
    },
    "adminRoutes": true,
    "sensitiveData": ["actor", "chat"]
  },
  "approvePermissionEscalation": true
}
```

**Success Response:**
```json
{
  "success": true,
  "moduleId": "shadowdark",
  "operation": "upgrade",
  "previousStatus": "disabled",
  "newStatus": "validated"
}
```

### `POST /admin/manager/:moduleId/uninstall`
Uninstalls a module and removes persisted artifact metadata.

### `POST /admin/manager/:moduleId/validate`
Re-runs manifest and compatibility validation for a module.

### Manager Policy Error Responses

`install` and `upgrade` may fail with the following structured errors:

- `403 trust-policy-blocked`: module trust tier is below the configured minimum policy
- `422 artifact-verification-failed`: remote artifact is missing or has malformed integrity/signature metadata
- `409 permission-escalation-requires-approval`: upgrade requested broader permissions without explicit approval
- `422 validation-failed`: manifest or compatibility validation failed
- `404 module-not-found`: target module does not exist in lifecycle/registry state

**Example Permission Escalation Block (409):**
```json
{
  "success": false,
  "moduleId": "shadowdark",
  "operation": "upgrade",
  "errorCode": "permission-escalation-requires-approval",
  "error": "Permission escalation requires explicit approval: Admin route access enabled; Sensitive data access added: chat"
}
```

**Example Artifact Verification Block (422):**
```json
{
  "success": false,
  "moduleId": "shadowdark",
  "operation": "upgrade",
  "errorCode": "artifact-verification-failed",
  "error": "Artifact integrity is required and must be sha256:<64 hex> for non-local sources"
}
```

---

## Source Management

### `GET /admin/sources`
Returns all configured source profiles.

### `POST /admin/sources`
Creates a new source profile. Validates `baseUrl` against the host allowlist.
**Body**: `{ "name": "...", "baseUrl": "index://...", "kind": "indexed", "enabled": true, "priority": 10 }`

### `PUT /admin/sources/:id`
Updates an existing source profile.
**Body**: `{ "name": "...", "enabled": false, ... }`

### `DELETE /admin/sources/:id`
Deletes a source profile. Cannot delete the `built-in` profile.

### `POST /admin/sources/:id/test`
Tests the connection to a source and returns metadata about the remote index.
**Response**: `{ "success": true, "moduleCount": 5, "publisher": "...", "schemaVersion": 1 }`

### `GET /admin/sources/:id/modules`
Returns the list of available modules from a specific remote source.
**Response**: `{ "success": true, "modules": { "moduleId": { ... } } }`


## Module Dependencies & Conflicts

Module manifests (`info.json`) can declare:

- **`dependencies`** (string[]): List of module IDs that must be enabled for this module to function.
- **`conflicts`** (string[]): List of module IDs that cannot be enabled at the same time.

Example `src/shadowdark/info.json`:
```json
{
  "id": "shadowdark",
  "title": "Shadowdark System",
  "dependencies": ["generic"],
  "conflicts": ["dnd5e", "morkborg"]
}
```

When enabling or disabling a module:
- **Enable**: Validates all dependencies exist and are enabled. Rejects if any conflicts are currently enabled.
- **Disable**: Validates no other enabled modules depend on this one. Rejects with a list of dependent modules if necessary.
