# Module Manifest Reference

This document is the authoritative guide for building a Sheet Delver system module. A module provides system-specific actor normalization, UI rendering, and optional server-side API routes for a Foundry VTT game system.

---

## Operating Modes

Modules run in one of two modes depending on how they are installed:

**Mode A — Source (development / trusted local install)**
- `info.json` manifest points to `.ts` / `.tsx` source files
- The platform loads them via `tsx` with full path-alias resolution
- Use this during development — no build step required

**Mode B — Artifact (production / remote distribution)**
- `info.json` manifest points to pre-compiled `.js` / `.mjs` files in a `dist/` directory
- The module is compiled independently using its own bundler config
- Required for modules distributed via the lifecycle chain (`install → validate → enable`)

Both modes use the same `info.json` schema. The registry auto-detects which mode applies based on the file extension of the manifest entry points.

---

## The SDK

All module code imports from a single package: `@sheet-delver/sdk`

```ts
import {
    BaseSystemAdapter,
    type ModuleContext,
    type ModuleFoundryClient,
    type FoundryActor,
    type ActorSheetData,
    getErrorMessage,
    resolveImage,
    processHtmlContent,
    simulateRoll,
} from '@sheet-delver/sdk';
```

During development this alias resolves to `src/shared/sdk/index.ts` via the project tsconfig paths. When bundling for distribution, mark `@sheet-delver/sdk` as external — the platform provides it at runtime.

**The SDK is the only import a module needs.** Modules must not import from internal platform aliases (`@shared/`, `@core/`, `@server/`, `@client/`, `@modules/`).

---

## Directory Layout

```
my-system/
  assets/             ← standard: CSS, images, fonts, any static files
  info.json           ← required: module metadata and manifest paths
  module/
    logic.ts          ← required: exports the Adapter class
    ui.tsx            ← required: exports the UIModuleManifest
    server.ts         ← optional: exports apiRoutes for server-side API handlers
  src/
    ...               ← your implementation (any structure you prefer)
```

---

## `info.json` Schema

```json
{
  "id": "my-system",
  "version": "1.0.0",
  "title": "My System Name",
  "experimental": false,
  "manifest": {
    "ui": "module/ui",
    "logic": "module/logic",
    "server": "module/server"
  },
  "compatibility": {
    "apiContracts": {
      "module-api": ">=1.0.0 <2.0.0",
      "ui-extension-api": ">=1.0.0 <2.0.0",
      "roll-engine-api": ">=1.0.0 <2.0.0"
    }
  },
  "discovery": {
    "packs": [
      { "id": "my-system.items", "type": "Item", "hydrate": true },
      { "id": "my-system.spells", "type": "Item", "hydrate": false }
    ]
  },
  "trust": { "tier": "first-party" },
  "aliases": ["my-sys"],
  "dependencies": [],
  "conflicts": [],
  "package": {
    "include": []
  }
}
```

| Field | Required | Description |
|---|---|---|
| `id` | Yes | Lowercase system identifier. Must match Foundry's system id. |
| `version` | No | Module version string. |
| `title` | Yes | Human-readable display name. |
| `experimental` | No | If `true`, module is hidden from the public registry. |
| `manifest.ui` | Yes | Path to the UI entry point (relative to module root). |
| `manifest.logic` | Yes | Path to the logic/adapter entry point. |
| `manifest.server` | No | Path to the server API entry point. |
| `compatibility.coreVersion` | No | SemVer range requirement against the Sheet Delver core version. |
| `compatibility.apiContracts` | No | SemVer range requirements against the platform SDK contracts. |
| `discovery.packs` | No | Compendium packs to index at world-ready time. Declared packs are fully hydrated by the platform before `initialize()` is called. |
| `trust.tier` | No | `first-party` \| `verified-third-party` \| `unverified` |
| `permissions` | No | Optional declarations for network, filesystem, admin route, or sensitive-data needs. |
| `aliases` | No | Alternate module/system ids used for lookup compatibility. |
| `dependencies` | No | Module ids this module depends on. |
| `conflicts` | No | Module ids this module cannot run alongside. |
| `package.include` | No | Extra files/dirs (relative to module root) to include in the archive beyond `assets/` and compiled JS. |

---

## `module/logic.ts` — The Adapter

Export a class named `Adapter` that extends `BaseSystemAdapter`.

```ts
import { BaseSystemAdapter, type ModuleContext, type FoundryActor, type ActorSheetData } from '@sheet-delver/sdk';

export class Adapter extends BaseSystemAdapter {
    systemId = 'my-system';

    normalizeActorData(actor: FoundryActor): ActorSheetData {
        return {
            id: actor._id,
            name: actor.name,
            type: actor.type,
            img: actor.img ?? '',
            system: actor.system,
            items: actor.items,
            effects: actor.effects,
            derived: {},
        };
    }

    match(actor: FoundryActor): boolean {
        return actor._stats?.systemId === 'SYSTEM_ID'; // It is recommended you use the system id as that will match guaranteed
    }

    async initialize(context: ModuleContext): Promise<void> {
        await super.initialize(context);
        // Use context.logger instead of importing a logger directly
        context.logger.info('My System adapter initialized');
        // Use context.platform.cache for persistent module-scoped storage
        // Use context.platform.discovery for UUID lookups in hydrated packs
    }
}

export default Adapter;
```

**Methods the platform calls (override as needed):**

| Method | When called | Default |
|---|---|---|
| `normalizeActorData(actor, client?)` | Every actor fetch | Raw passthrough |
| `match(actor)` | Actor dispatch | Returns `false` |
| `initialize(context)` | On first load | Stores context |
| `getSystemData(client, options?)` | System info route | Returns `{}` |
| `getDiscoveryConfig()` | World-ready sync | Returns empty |
| `getActorCardData(actor)` | Dashboard card render | Returns name/img |
| `computeActorData(actor)` | After normalization | Returns `{}` |
| `categorizeItems(actor)` | After normalization | Returns `{ all: [] }` |
| `getRollData(actor, type, key, options?)` | Roll dispatch | Returns `null` |
| `performAutomatedSequence(client, actor, rollData, options)` | Automated rolls | Returns `null` |
| `resolveActorNames(actor, cache)` | During normalization | noop |
| `getInitiativeFormula(actor)` | Combat initiative | Returns `'1d20'` |
| `validateUpdate(path, value)` | Real-time updates | Returns `true` |

**Note on `initialize(context)`:** The platform runs discovery sync (`getDiscoveryConfig()`) before calling `initialize()`. By the time `initialize()` is called, all declared compendium packs, in info.json, are already hydrated in the platform cache and accessible via `context.platform.discovery`. Adapters should read from the context rather than fetching via a client during initialization.

**Actor projection contract:** Actor adapter methods receive hydrated raw actor documents from the platform actor cache. Keep `getActorCardData`, `normalizeActorData`, `computeActorData`, and `categorizeItems` deterministic from the actor and injected SDK services. The `getActor()` and `getActors()` SDK/request methods remain the public read surface, but they resolve from the platform actor cache and fail as not-ready before bootstrap completes; they must not repeatedly fetch from Foundry. Use `fetchByUuid` or compendium discovery only for exceptional linked references that are not embedded in the actor.

---

## `module/ui.tsx` — The UI Manifest

Export a `UIModuleManifest` as the default export.

```ts
import type { ModuleInfo, UIModuleManifest } from '@sheet-delver/sdk';
import infoJson from '../info.json';

const info = infoJson as ModuleInfo;

const manifest: UIModuleManifest = {
    info,
    sheet: () => import('../src/ui/MySheet'),
    rollModal: () => import('../src/ui/MyInitiativeModal'),
    actorPage: () => import('../src/ui/pages/ActorPage'),
    tools: {
        'generator': () => import('../src/ui/tools/Generator'),
    },
    dashboardTools: () => import('../src/ui/MyDashboardTools'),
    stylesheet: 'assets/styles.css',
};

export default manifest;
```

`info` is synchronous module metadata. Import `info.json` statically and cast it to `ModuleInfo` so the UI manifest carries the same strict shape the registry validates.

All component entries are lazy `() => import(...)` thunks. The platform calls them on demand. The imported module must have a default export that is a React component.

`stylesheet` is optional. When provided, it must point to a CSS file in the module's `assets/` directory and the platform injects it when the module mounts.

`dashboardLoading` is also available for modules that need a custom dashboard loading component.

**Platform hooks — use `useSDK()` and `useSDKComponents()` from the SDK:**

```ts
import { useSDK, useSDKComponents } from '@sheet-delver/sdk';

function MySheet() {
    const {
        token,           // string | null — JWT for authenticated fetch
        currentUser,     // { id, name, isGM, role } | null
        system,          // { id, title, version } | null
        isConnected,     // boolean — true when world is active
        baseUrl,         // platform origin (window.location.origin)
        foundryUrl,      // Foundry server URL for image resolution
        resolveImageUrl, // (path: string) => string — resolves relative image paths
        addNotification, // (message, type?, options?) => void — toast
        isDiceTrayOpen, toggleDiceTray,
        isChatOpen, setChatOpen,
        fetchWithAuth,   // (input, init?) => Promise<Response> — auth-injected fetch
        onActorUpdate,   // (actorId, cb) => () => void — realtime subscription
        logger,          // { debug, info, warn, error } — prefixed console logger
    } = useSDK();

    const {
        LoadingModal,       // platform LoadingModal component
        RollDialog,         // platform RollDialog component
        ConfirmationModal,  // platform ConfirmationModal component
        RichTextEditor,     // platform RichTextEditor component
        SharedContentModal, // platform SharedContentModal component
    } = useSDKComponents();
}
```

`useSDK()` returns the full platform context. `useSDKComponents()` injects platform UI components — modules must NOT import these from `@client/ui/components/` directly.

**Realtime actor updates — example pattern:**

`onActorUpdate` is an invalidation signal emitted after the backend actor cache has changed. The payload shape is `{ actorId, action }`, where `action` is `create`, `update`, or `delete`; module UI should refetch through the API instead of applying socket diffs directly.

```ts
import { useSDK } from '@sheet-delver/sdk';
import type { RealtimeActorUpdatePayload } from '@sheet-delver/sdk';
import { useEffect, useCallback } from 'react';

function MyActorPage({ actorId }: { actorId: string }) {
    const { fetchWithAuth, onActorUpdate } = useSDK();

    const fetchActor = useCallback(async (silent = false) => {
        const res = await fetchWithAuth(`/api/actors/${actorId}`);
        const data = await res.json();
        // update state...
    }, [actorId, fetchWithAuth]);

    useEffect(() => {
        fetchActor();
        const cleanup = onActorUpdate(actorId, () => fetchActor(true));
        return cleanup;
    }, [actorId, fetchActor, onActorUpdate]);
}
```

---

## `module/server.ts` — Server API Routes

Export `apiRoutes` as a named or default export.

```ts
import type { ModuleServerExport, ModuleServerRequest, ModuleServerParams } from '@sheet-delver/sdk';
import { getErrorMessage } from '@sheet-delver/sdk';

async function handleLevelUp(req: ModuleServerRequest, params: ModuleServerParams) {
    try {
        const { route } = await params.params;
        const actorId = route[1];
        const body = await req.json<{ targetLevel: number }>();

        const actor = await req.foundryClient.getActor(actorId);
        // ... compute level-up changes ...
        await req.foundryClient.updateActor(actorId, { 'system.level.value': body.targetLevel });

        return { status: 200, json: async () => ({ success: true }) };
    } catch (err) {
        return { status: 500, json: async () => ({ error: getErrorMessage(err) }) };
    }
}

export const apiRoutes: ModuleServerExport['apiRoutes'] = {
    'actor/[id]/level-up': handleLevelUp,
};
```

Routes are matched by pattern. `[segment]` is a wildcard matching any single path segment.

**`ModuleServerRequest` provides:**

| Property | Type | Description |
|---|---|---|
| `req.json<T>()` | `Promise<T>` | Parsed request body |
| `req.method` | `string` | HTTP method |
| `req.url` | `string` | Full request URL |
| `req.headers` | `Record<string, string \| string[]>` | Request headers |
| `req.foundryClient` | `ModuleFoundryClient` | Platform-mediated Foundry actions |
| `req.userSession` | `UserSession \| undefined` | Requesting user info (`userId`, `username`, `isGM`, `role`) |

**`ModuleFoundryClient` — platform-mediated actions:**

The module does not talk to Foundry directly. The platform executes all operations on the module's behalf.

| Method | Description |
|---|---|
| **Messaging** | |
| `roll(formula, label?, options?)` | Dice roll, posts result to chat |
| `sendMessage(data, options?)` | Post a chat message |
| `useItem(actorId, itemId)` | Trigger an item use action |
| **Actor CRUD** | |
| `getActor(id)` | Fetch actor data |
| `getActors()` | Fetch all actors in the world |
| `createActor(actorData)` | Create a new actor |
| `updateActor(id, updates)` | Update actor data |
| `deleteActor(actorId)` | Delete an actor |
| **Actor Item CRUD** | |
| `createActorItem(actorId, itemData)` | Add an item to an actor |
| `updateActorItem(actorId, itemData)` | Update an actor's item |
| `deleteActorItem(actorId, itemId)` | Remove an item from an actor |
| **Active Effect CRUD** | |
| `createActorEffect(actorId, effectData)` | Add an active effect to an actor |
| `updateActorEffect(actorId, effectId, updates)` | Update an active effect on an actor |
| `deleteActorEffect(actorId, effectId)` | Remove an active effect from an actor |
| `createItemEffect(actorId, itemId, effectData)` | Add an effect to an actor's item |
| `updateItemEffect(actorId, itemId, effectId, updates)` | Update an effect on an actor's item |
| `deleteItemEffect(actorId, itemId, effectId)` | Remove an effect from an actor's item |
| **Document access** | |
| `fetchByUuid(uuid)` | Fetch any Foundry document by UUID |
| `getWorldItems(options?)` | Fetch world-owned items (not compendium). Prefer `context.platform.discovery` for compendium pack data. |
| `drawTable(tableId, options?)` | Fetch a RollTable and simulate a draw. Returns `DrawResult`. |
| **Utilities** | |
| `resolveUrl(path)` | Resolve a relative path to a full URL |
| `getSystemId()` | Current active Foundry system id |
| `isConnected` | Whether the platform has an active Foundry connection |

---

## Platform Injection

### `ModuleContext` — injected at `initialize(context)`

```ts
async initialize(context: ModuleContext): Promise<void> {
    // Namespaced logger — output prefixed with [module:my-system]
    context.logger.info('Adapter initialized');
    context.logger.warn('Something unexpected happened');

    // Scoped persistent cache — namespaced to this module
    await context.platform.cache.set('configKey', { value: 42 });
    const cached = await context.platform.cache.get<{ value: number }>('configKey');

    // Compendium discovery — lookups into hydrated packs declared in getDiscoveryConfig()
    const item = await context.platform.discovery.getById('Item', 'someUuid');
    const found = await context.platform.discovery.findOne('Item', { name: 'Longsword' });
}
```

**`context.logger`** — use this instead of importing a logger. Output is namespaced to the module id automatically.

**`context.platform.cache`** — persistent key-value store scoped to this module. Data survives server restarts. Other modules cannot read this module's data.

**`context.platform.discovery`** — lookups into compendium packs declared in `getDiscoveryConfig()`. Packs are hydrated by the platform before `initialize()` is called.

### `ModuleFoundryClient` — injected per API request

Available as `req.foundryClient` in API route handlers. Pre-authenticated and scoped to the requesting user's session. Actor reads come from the platform actor cache after bootstrap; actor/item/effect writes go through Foundry and are mirrored back into that cache. The underlying socket connection is fully managed by the platform — modules interact through the methods above only.

---

## Utility Functions

The SDK exports utility functions for common tasks:

```ts
import {
    getErrorMessage,      // safely extract error.message from unknown
    resolveImage,         // resolve relative Foundry image paths to full URLs
    processHtmlContent,   // fix relative src= attributes in Foundry-enriched HTML
    getSafeDescription,   // extract description string from Foundry system objects
    simulateRoll,         // simulate NdX or NdX±M dice roll locally
    simulateTableDraw,    // simulate a draw from a fetched RollTable document
} from '@sheet-delver/sdk';
```

| Function | Signature | Description |
|---|---|---|
| `getErrorMessage` | `(error: unknown) => string` | Safe error message extraction for catch blocks |
| `resolveImage` | `(path: string, baseUrl?: string) => string` | Prepend Foundry base URL to relative image paths |
| `processHtmlContent` | `(html: string, baseUrl?: string) => string` | Fix relative `src=` attributes in enriched HTML |
| `getSafeDescription` | `(system: unknown) => string` | Extract description from `{ value }`, string, or `.desc` |
| `simulateRoll` | `(formula: string, rollOverride?: number) => { roll, formula }` | Local dice simulation for `NdX` and `NdX±M` formulas |
| `simulateTableDraw` | `(table, options?) => Promise<DrawResult>` | Simulate a draw from a RollTable document |

---

## Bundler Config (Mode B — Artifact)

Reference `tsup` config for building a standalone artifact:

```ts
// tsup.config.ts
import { defineConfig } from 'tsup';

export default defineConfig([
    {
        entry: { logic: 'module/logic.ts' },
        format: ['esm'],
        outDir: 'dist',
        external: ['@sheet-delver/sdk'],
    },
    {
        entry: { server: 'module/server.ts' },
        format: ['esm'],
        outDir: 'dist',
        external: ['@sheet-delver/sdk'],
    },
    {
        entry: { ui: 'module/ui.tsx' },
        format: ['esm'],
        outDir: 'dist',
        external: ['@sheet-delver/sdk', 'react', 'react-dom'],
    },
]);
```

Update `info.json` manifest entries to point to compiled output:

```json
"manifest": {
    "ui": "dist/ui.js",
    "logic": "dist/logic.js",
    "server": "dist/server.js"
}
```

---

## Packaging a Module

Use the built-in packaging script to produce a distributable archive without touching your source tree:

```sh
npm run module:package <moduleId>
```

The script:
1. Compiles all three entry points (`logic`, `ui`, `server`) via esbuild into an OS temp staging directory.
2. Writes a patched `info.json` in the staging directory with manifest paths pointing to `dist/*.js`.
3. Archives `dist/`, `assets/`, `info.json`, and any `LICENSE` / `README.md` files into `<moduleId>-<version>.tar.gz` in the project root.

The original source directory and its `info.json` are **never modified**. The archive is ready to be hosted on an index server or installed via a source profile.

### Static Assets

Static files (CSS, images, fonts) should be placed in the `assets/` directory at the module root.
The packaging script will always include this directory automatically.

For non-standard files or directories, you can declare them in `info.json`:
```json
"package": {
    "include": ["data/", "templates/"]
}
```

Module CSS should be placed in `assets/` and declared via the `stylesheet` field in the UI Manifest (`UIModuleManifest`). The platform will automatically inject it when the module mounts.

To include source maps for debugging, run the packager with the `--sourcemap` flag:
```sh
npm run module:package <moduleId> --sourcemap
```

---

## Checking a Module

Use the built-in checker before packaging or publishing:

```sh
npm run module:check <moduleId>
```

The checker validates SDK compliance and package readiness for modules in `<DATA_DIR>/local/modules/`. It is intended for SDK-migrated modules; legacy modules may fail until their internal platform imports are replaced.

The script checks:
1. `info.json` shape and compatibility constraints.
2. Manifest entry resolution for `logic`, `ui`, and optional `server`.
3. Export shape: logic exports `Adapter`, UI has a default manifest export, server exports named `apiRoutes`.
4. SDK import boundaries. Module code should import platform APIs from `@sheet-delver/sdk`, not `@shared/`, `@client/`, `@server/`, `@core/`, `@modules/`, or `@/`.
5. TypeScript with the module's `tsconfig.json` when present.
6. Dry esbuild bundles for declared entries using the same externals as packaging.

When it finds legacy platform imports, it prints migration hints for common replacements such as `useSDK()`, `useSDKComponents()`, `ModuleServerRequest`, `req.foundryClient`, and SDK utility exports.

For CI or tooling, emit a structured result:

```sh
npm run module:check <moduleId> -- --json
```

---

## Development Workflow

### Module locations

The platform scans two separate on-disk locations for modules:

| Location | Purpose | Managed by lifecycle? |
|---|---|---|
| `<DATA_DIR>/local/modules/` | Local dev — TypeScript source, loaded directly | No — scan-only |
| `<DATA_DIR>/modules/` | Managed installs — installed/upgraded/uninstalled via source profiles | Yes |
| `src/modules/` | Built-in platform modules (deprecated location) | Yes (read-only) | 

The local dev path can be overridden with the `SHEET_DELVER_LOCAL_MODULES` environment variable.

**Use `<DATA_DIR>/local/modules/` during development.** The lifecycle install/upgrade/uninstall commands never touch this directory, so you can iterate freely without risking your source tree.

### Webpack alias resolution

The Next.js client resolves module UI files through two separate aliases (both configured in `next.config.ts`):

| Alias | Resolves to |
|---|---|
| `@local-modules` | `<DATA_DIR>local/modules/` (or `$SHEET_DELVER_LOCAL_MODULES`) |
| `@modules` | `<DATA_DIR>/modules/` |

`getUIModule(systemId)` fetches `GET /api/registry/sources` on first call to learn which source is active for each module, then dynamically imports from the correct alias. Both alias trees are bundled at build time — switching sources at runtime only selects which already-bundled chunk executes.

### Server-side hot reload (adapters)

In development mode, the logic adapter is reloaded automatically when its source file changes — no server restart needed.

The registry tracks the file's last-modified timestamp (`mtime`) for each loaded adapter. On every `getAdapter()` call, if the mtime has increased the cached instance is evicted and the adapter module is re-imported using a URL cache-bust query (`?v=<mtime>`), forcing Node.js's ESM loader to treat it as a new module.

This only applies to the server-side logic adapter. UI component changes are picked up by Next.js's normal HMR.

---

## Module Lifecycle (Admin Panel)

### States

A module moves through the following lifecycle states:

```
discovered → validated → enabled
                       ↓
                    disabled
                       ↓
                    errored    (runtime failure — auto-disabled)
                       ↓
                  uninstalling → removed
```

`installed` and `upgrading` are transient states used during install/upgrade operations.

### Per-source enable/disable

When both a local dev version and a managed install of the same module exist simultaneously, the lifecycle panel shows a **Managed / Local Dev** source toggle and independent enable/disable controls for each source.

**Only one source may be enabled at a time.** The enable button for a source is grayed out with an explanatory tooltip when the other source is currently enabled. You must disable the active source before enabling the other.

The platform preserves each source's enabled state independently (`localEnabled` / `managedEnabled` in the lifecycle store). Switching the active source restores the saved state for the newly selected source rather than inheriting the state from the one being left.

### Source switching and client hot reload

When an admin switches a module's active source via the lifecycle panel (`Managed ↔ Local Dev`), the following happens automatically:

1. **Server** — the registry updates the active source in the lifecycle store (`state.json`) and re-scans so the logic adapter from the new source is used for all subsequent requests.

2. **Broadcast** — the server emits a `moduleSourceChanged` socket event to every connected browser client: `{ moduleId: string, source: ModuleSourceCategory }`.

3. **Client (global)** — `FoundryContext` receives the event, calls `invalidateModuleSourceCache()` to clear the cached active-source map and manifest cache, and re-hydrates `activeUIModule` if the affected module is the currently active system.

4. **Client (actor page)** — `ActorPageRouter` also listens for `moduleSourceChanged`. If the actor currently being viewed belongs to the switched system, it increments an internal `resolveKey` which re-runs the full actor resolution: re-fetches the actor, calls `getUIModule()` against the now-fresh source map, and mounts the component from the new source — no page refresh required.

5. **Admin panel** — `ModuleLifecycleControl` calls `invalidateModuleSourceCache()` after a successful switch API call so any subsequent actor open in the same tab also picks up the new source immediately.

**`GET /api/registry/sources`** is the public (no-auth) endpoint that returns the `moduleId → activeSource` map. It is fetched lazily by `getUIModule()` on first call and cached in memory. `invalidateModuleSourceCache()` resets both the source map and the manifest cache, ensuring the next call re-fetches and re-imports cleanly.

---

## Migrating an Existing Module to the SDK

1. Move your module directory to `<DATA_DIR>/local/modules/<systemId>/`.
2. Replace all internal platform imports (`@shared/`, `@client/`, `@core/`, etc.) with `@sheet-delver/sdk`.
3. Extend `BaseSystemAdapter` for your logic entry point. The `override` keyword is optional TypeScript syntax; the platform dispatches adapter methods by name and does not require it. The examples omit it for compatibility and readability.
4. Use `useSDK()` for runtime platform data and `useSDKComponents()` for platform UI components in your React components.
5. Identify your actors using `actor._stats?.systemId` — this is Foundry's authoritative system identifier and is available in the raw actor document without any derived-value computation.
6. Image paths — always pass actor images through `resolveImage(actor.img ?? '', foundryUrl)` (available from `useSDK().foundryUrl` in UI, or via the base class `this.foundryUrl` getter in the adapter). Foundry returns relative paths that must be prefixed with the Foundry server origin before the browser can load them.
7. Verify with `npx tsc --noEmit` from the project root — modules share the project tsconfig and can type-check independently via their own `tsconfig.json` that extends `.managed/tsconfig.paths.json`.
