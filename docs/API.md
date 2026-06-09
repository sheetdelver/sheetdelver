# API Documentation

The Sheet Delver API exposes Foundry-backed data through the Core Service. User
routes are authenticated with a bearer token. Admin routes are protected by the
admin session and CSRF flow.

Examples use abstract ids such as `<moduleId>`, `<actorId>`, and
`example-system`; do not treat them as bundled systems.

---

## Authentication

Protected user routes require:

```http
Authorization: Bearer <token>
```

Tokens are returned by `POST /api/login`.

Admin mutation routes require the admin session plus CSRF token handled by the
admin UI client.

---

## Session And Status

### `GET /api/status`

Auth: try-auth.

Returns connection, world, current user, and readiness status. `initialized:
true` means world bootstrap has completed, including module discovery,
compendium indexing/hydration, and primary document cache seeding.

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
  "appVersion": "0.7.0"
}
```

### `POST /api/login`

Body:

```json
{ "username": "User", "password": "password" }
```

Response:

```json
{ "success": true, "token": "session-token", "userId": "user-id" }
```

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

### `GET /api/actors`

Auth: protected.

Returns actors visible to the current user, separated into owned and read-only
sets. Reads resolve from the platform primary document stores after bootstrap.
Before bootstrap completes, the route returns `503`.

### `GET /api/actors/:id`

Auth: protected.

Returns normalized actor sheet data for one actor visible to the current user.
The platform reads the hydrated actor document, then applies the active adapter's
projection methods.

### `PATCH /api/actors/:id`

Auth: protected.

Updates actor-level data using dot notation. Writes run through the user's
Foundry transport and are mirrored into platform stores.

### `POST /api/actors/:id/update`

Auth: protected.

Routes hybrid actor updates, including supported embedded item/effect paths.

### `POST /api/actors/:id/roll`

Auth: protected.

Executes a platform-supported actor roll.

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

### `POST /api/modules/:id/ui-error`

Auth: try-auth.

Records a browser-side module UI import/evaluation failure into lifecycle health.
This is an operational health signal so the admin can see why a module fell back
to the generic UI.

```json
{
  "source": "managed",
  "message": "Failed to load runtime UI manifest"
}
```

### `GET /api/modules/:id/assets/*`

Auth: none.

Serves files from a module's `assets/` directory. The route resolves both local
dev and managed module roots using the configured data directory.

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
document, roll, table, and chat surface.

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

The browser-facing admin UI calls these through the Next.js proxy path
`/api/admin/...`. The backend Core Service mounts them at `/admin/...`.

### `GET /admin/auth/status`

Returns whether an admin account exists.

### `POST /admin/auth/setup`

Creates the first admin account.

### `POST /admin/auth/login`

Authenticates the admin account and returns an admin session token plus CSRF
token.

### `POST /admin/auth/reset`

Resets the admin password using the setup token and revokes active admin
sessions.

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

### `POST /admin/manager/:moduleId/install`

Installs a discovered module under manager policy.

```json
{
  "source": "index://source-id",
  "version": "1.0.0",
  "integrity": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "signature": "minisign:...",
  "permissions": {
    "network": { "outbound": false, "allowHosts": [] },
    "filesystem": { "read": ["moduleData"], "write": ["moduleData"] },
    "adminRoutes": false,
    "sensitiveData": []
  }
}
```

### `POST /admin/manager/:moduleId/upgrade`

Upgrades a managed module under trust, verification, and permission-escalation
policy.

### `POST /admin/manager/:moduleId/uninstall`

Uninstalls a managed module and removes persisted artifact metadata.

### `POST /admin/manager/:moduleId/validate`

Re-runs manifest, compatibility, and managed artifact health checks.

Manager policy errors use structured `errorCode` values, including:

- `trust-policy-blocked`
- `artifact-verification-failed`
- `permission-escalation-requires-approval`
- `validation-failed`
- `module-not-found`

---

## Source Profiles

### `GET /admin/sources`

Returns configured source profiles. The default local source profile is
protected and cannot be modified or deleted.

### `POST /admin/sources`

Creates a source profile.

```json
{
  "name": "Example Registry",
  "baseUrl": "https://registry.example",
  "kind": "indexed",
  "enabled": true,
  "priority": 10
}
```

### `PUT /admin/sources/:id`

Updates a source profile.

### `DELETE /admin/sources/:id`

Deletes a source profile unless it is the protected default local source.

### `POST /admin/sources/:id/test`

Tests an indexed source profile.

### `GET /admin/sources/:id/modules`

Returns modules available from an indexed source profile.

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
