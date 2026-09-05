# Module Manifest Reference

This document is the authoritative contract for building a Sheet Delver system
module. A module provides system-specific actor projection, React UI surfaces,
optional server-side API routes, static assets, and optional module-owned data.

This reference lives under `docs/` because it is authoring documentation, not a
runtime source file. Module source should live under the data directory paths
described below.

---

## Operating Modes

Modules run in one of two source categories.

**Mode A - Local dev source**

- Directory: `<DATA_DIR>/local/modules/<moduleId>/`
- Manifest entries usually point to TypeScript / TSX source, for example
  `module/logic`, `module/ui`, and optional `module/server`.
- Server logic and server routes are imported by the host runtime during
  development.
- UI source is bundled through the generated `.managed/module-ui-registry.ts`
  before `next dev` / `next build`.
- Lifecycle install, upgrade, and uninstall operations do not modify this tree.

**Mode B - Managed artifact**

- Directory: `<DATA_DIR>/modules/<moduleId>/`
- Manifest entries point to compiled JavaScript / ESM artifacts, usually
  `dist/logic.js`, `dist/ui.js`, and optional `dist/server.js`.
- The lifecycle chain owns this tree: install, validate, enable, disable,
  upgrade, and uninstall.
- Managed UI artifacts are not bundled into the Next build. The browser loads
  them at runtime through `GET /api/modules/:id/ui`, which rewrites bare SDK and
  React imports to host-provided globals.

Both modes use the same `info.json` schema. Local development is checked by
`module:check`; packaging also runs `module:check` before producing an artifact.
Installed artifacts may be older than the current SDK. The registry performs a
lightweight managed-artifact health check: fatal load problems become blocking
errors, while survivable SDK drift becomes an admin-visible warning.

---

## Public SDK Entry Points

Use the public SDK entry points only:

```ts
import {
    BaseSystemAdapter,
    type ActorSheetData,
    type FoundryActor,
    type ModuleInfo,
    type UIModuleManifest,
    getErrorMessage,
    resolveImage,
    processHtmlContent,
    simulateRoll,
} from '@sheet-delver/sdk';

import {
    useSDK,
    useSDKComponents,
    useActorSheet,
    useDocument,
    useDocumentMutation,
    useModuleSettings,
} from '@sheet-delver/sdk/react';

import {
    json,
    error,
    type ModuleRuntime,
    type ModuleRouteTable,
    type ModuleServerRequest,
    type ModuleServerParams,
} from '@sheet-delver/sdk/server';
```

The shared barrel, `@sheet-delver/sdk`, contains environment-agnostic types,
adapter contracts, logger helpers, and pure utilities. Client hooks live under
`@sheet-delver/sdk/react`. Server runtime and route helpers live under
`@sheet-delver/sdk/server`.

Modules must not import internal platform aliases such as `@shared/`, `@client/`,
`@server/`, `@core/`, `@modules/`, or `@/`.

Modules must also avoid direct `console.*` calls. Use `runtime.logger` in adapter
and server-runtime code, `useSDK().logger` in React UI, or `logger` /
`createModuleLogger()` from `@sheet-delver/sdk` in shared helper files.

---

## Directory Layout

```text
my-system/
  assets/
    styles.css              # optional static CSS, images, fonts, and other files
  info.json                 # required module metadata and manifest paths
  module/
    logic.ts                # required: exports Adapter
    ui.tsx                  # required: exports UIModuleManifest
    server.ts               # optional: exports apiRoutes
  src/
    styles/
      tailwind.css          # optional author-owned Tailwind entry
    ...                     # implementation files
```

`assets/` is served as static content. `src/styles/tailwind.css`, when present,
is compiled by `module:package` into the reserved artifact
`assets/<moduleId>.tailwind.css`; authors do not set that output path manually.

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
    "coreVersion": ">=1.0.0",
    "apiContracts": {
      "module-api": ">=1.0.0 <2.0.0",
      "ui-extension-api": ">=1.0.0 <2.0.0",
      "roll-engine-api": ">=1.0.0 <2.0.0"
    }
  },
  "compendiumPacks": {
    "packs": [
      { "id": "my-system.items", "type": "Item", "hydrate": true },
      { "id": "my-system.spells", "type": "Item", "hydrate": false }
    ]
  },
  "settings": [
    {
      "key": "sheetDensity",
      "type": "select",
      "default": "comfortable",
      "label": "Sheet density",
      "options": [
        { "value": "comfortable", "label": "Comfortable" },
        { "value": "compact", "label": "Compact" }
      ]
    }
  ],
  "trust": { "tier": "unverified" },
  "permissions": {
    "network": { "outbound": false },
    "adminRoutes": false
  },
  "aliases": ["my-sys"],
  "dependencies": [],
  "conflicts": [],
  "package": {
    "include": []
  }
}
```

`version` is the module release and is independent from
`compatibility.coreVersion` and the named API contract ranges. Contract
versions use semantic versioning per surface: patch releases preserve the
contract, minor releases add backward-compatible capabilities, and major
releases may break consumers. A module that adopts a new capability must raise
the corresponding minimum range. The host keeps one authoritative contract map
in `src/shared/sdk/contractVersions.ts`, re-exported by
`@sheet-delver/sdk`; module manifests declare compatible ranges rather than
copying the host's current version as an exact requirement.

| Field | Required | Description |
|---|---|---|
| `id` | Yes | Lowercase system identifier. It should match Foundry's system id. |
| `title` | Yes | Human-readable display name. |
| `version` | No | Module version string. |
| `experimental` | No | Marks the module as experimental for registry tooling. |
| `manifest.ui` | Yes | UI manifest entry path relative to the module root. |
| `manifest.logic` | Yes | Adapter entry path relative to the module root. |
| `manifest.server` | No | Server route entry path relative to the module root. |
| `compatibility.coreVersion` | No | SemVer range for the Sheet Delver host version. |
| `compatibility.apiContracts` | No | SemVer ranges for named SDK contract versions. |
| `compendiumPacks.packs` | No | Compendium packs the host should index, optionally hydrate, and expose through `runtime.compendium`. |
| `settings` | No | Client setting declarations consumed by `useModuleSettings()`. |
| `trust.tier` | No | `first-party`, `verified-third-party`, or `unverified`. |
| `permissions` | No | Operator-facing declarations for requested capabilities. These do not grant privileges. |
| `aliases` | No | Alternate module/system ids used for lookup compatibility. |
| `dependencies` | No | Module ids this module depends on. |
| `conflicts` | No | Module ids this module cannot run alongside. |
| `package.include` | No | Extra files or directories to include in packaged artifacts. |
| `compiledStyles` | No | Reserved packager output. Authors must not set this in source manifests. |

`permissions` is a declaration, not an authorization bypass. Foundry ownership and
the Sheet Delver request runtime still gate document reads and writes. Module
server routes must perform user work through `req.runtime`; they must not use a
core socket, service token, or system user path to impersonate the caller.

---

## `module/logic.ts` - Adapter

Export a class named `Adapter` that extends `BaseSystemAdapter`.

```ts
import {
    BaseSystemAdapter,
    type ActorSheetData,
    type FoundryActor,
} from '@sheet-delver/sdk';
import type { ModuleRuntime } from '@sheet-delver/sdk/server';

export class Adapter extends BaseSystemAdapter {
    systemId = 'my-system';

    match(actor: FoundryActor): boolean {
        return actor._stats?.systemId === this.systemId;
    }

    normalizeActorData(actor: FoundryActor): ActorSheetData {
        return {
            id: actor._id,
            name: actor.name,
            type: actor.type,
            img: actor.img ?? '',
            system: actor.system ?? {},
            items: actor.items ?? [],
            effects: actor.effects ?? [],
            derived: {},
        };
    }

    async initialize(runtime: ModuleRuntime): Promise<void> {
        await super.initialize(runtime);

        runtime.logger.info('My System adapter initialized');

        const cached = await runtime.dataStore.get<{ value: number }>('configKey');
        if (!cached) {
            await runtime.dataStore.set('configKey', { value: 42 });
        }
    }
}

export default Adapter;
```

**Methods the platform calls:**

| Method | When called | Default |
|---|---|---|
| `match(actor)` | Actor dispatch | Returns `false`. |
| `normalizeActorData(actor)` | Actor projection | Raw passthrough with image resolution. |
| `initialize(runtime)` | Adapter activation | Stores the runtime and wires the SDK logger sink. |
| `dispose(runtime)` | World teardown or adapter clear | No-op. |
| `getSystemData(options?)` | `/system/data` route | Returns `{}`. |
| `getCompendiumPackConfig()` | World-ready sync | Returns empty pack list. |
| `getActorCardData(actor)` | Dashboard card render | Returns name and image. |
| `computeActorData(actor)` | After normalization | Returns `{}`. |
| `categorizeItems(actor)` | After normalization | Returns `{ all: actor.items }`. |
| `getRollData(actor, type, key, options?)` | Roll dispatch | Returns `null`. |
| `getInitiativeFormula(actor)` | Combat initiative | Returns `'1d20'`. |
| `validateUpdate(path, value)` | Client update validation | Returns `true`. |

Adapter methods are pure projection unless they explicitly use the injected
`ModuleRuntime`. The removed broad client surface is not available:
`ModuleFoundryClient`, adapter `client` parameters, `performAutomatedSequence`,
and `resolveActorNames` are not module APIs. Automated workflows belong in
module-authored server routes over `req.runtime`.

### Runtime Services

`initialize(runtime)` receives a long-lived, module-scoped `ModuleRuntime`:

| Service | Description |
|---|---|
| `runtime.moduleId` | Active module id. |
| `runtime.logger` | Namespaced platform logger. |
| `runtime.foundryUrl` | Connected Foundry server URL, useful for image resolution. |
| `runtime.dataStore` | Durable module-scoped key/value store. |
| `runtime.compendium` | Read surface for declared compendium pack rows. |
| `runtime.documents` | Read-only world document surface: `list`, `get`, and `fetchByUuid`. |

Declared compendium packs are indexed before `initialize()` is called. Packs with
`hydrate: true` can be read through `runtime.compendium` and are also available
to compendium UUID reads. Missing, undeclared, or non-hydrated pack rows fail
closed rather than live-fetching from Foundry as normal module behavior.

---

## `module/ui.tsx` - UI Manifest

Export a `UIModuleManifest` as the default export.

```tsx
import type { ModuleInfo, UIModuleManifest } from '@sheet-delver/sdk';
import infoJson from '../info.json';

const info = infoJson as ModuleInfo;

const manifest: UIModuleManifest = {
    info,
    sheet: () => import('../src/ui/MySheet'),
    rollModal: () => import('../src/ui/MyRollDialog'),
    actorPage: () => import('../src/ui/pages/ActorPage'),
    tools: {
        generator: () => import('../src/ui/tools/Generator'),
    },
    dashboardTools: () => import('../src/ui/MyDashboardTools'),
    stylesheet: 'assets/styles.css',
};

export default manifest;
```

Component entries are lazy `() => import(...)` thunks. Each imported module must
default-export a React component. `stylesheet` is optional and must point at CSS
under `assets/`. The packager-managed Tailwind artifact is loaded separately via
`compiledStyles`; do not add it to source `info.json`.

Use client hooks from `@sheet-delver/sdk/react`:

```tsx
import { useEffect } from 'react';
import {
    useSDK,
    useSDKComponents,
    useActorSheet,
    useDocumentMutation,
} from '@sheet-delver/sdk/react';

export default function MySheet({ actorId }: { actorId: string }) {
    const {
        currentUser,
        moduleId,
        worldId,
        foundryUrl,
        resolveImageUrl,
        assetUrl,
        addNotification,
        events,
        logger,
    } = useSDK();

    const { LoadingModal, RollDialog } = useSDKComponents();
    const sheet = useActorSheet(actorId);
    const actors = useDocumentMutation('Actor');

    useEffect(() => {
        return events.on('document:changed', payload => {
            if (payload.type === 'Actor' && payload.id === actorId) {
                logger.debug('Actor changed', payload);
                sheet.refresh();
            }
        });
    }, [actorId, events, logger, sheet]);

    // Render the system-specific sheet...
    return null;
}
```

`useSDK().events` replaces the older actor-only `onActorChanged` callback. The
stable signals are `world:ready`, `world:teardown`, `connection:changed`,
`module:initialized`, `module:disposed`, `document:changed`,
`document:listInvalidated`, and `content:shared`.

Use the host-owned document hooks instead of hand-rolled fetch/update loops when
possible:

| Hook | Purpose |
|---|---|
| `useDocument(type, id)` | Subscribe to one host-cached document. |
| `useDocumentMutation(type)` | Create, patch, delete, commit, and embedded mutations through host APIs. |
| `useActorSheet(actorId)` | Actor-focused read, refresh, roll, and patch controller. |
| `useModuleSettings(info)` | Read and persist client settings declared in `info.json`. |
| `createActorPage(Component)` | Wrap a sheet component in the standard actor-page shell. |

---

## `module/server.ts` - Server API Routes

Export a static `apiRoutes` table as a named or default export.

```ts
import { getErrorMessage } from '@sheet-delver/sdk';
import {
    error,
    json,
    type ModuleRouteTable,
    type ModuleServerParams,
    type ModuleServerRequest,
} from '@sheet-delver/sdk/server';

async function handleLevelUp(req: ModuleServerRequest, params: ModuleServerParams) {
    try {
        const { route } = await params.params;
        const actorId = route[1];
        const body = await req.json<{ targetLevel: number }>();

        const actor = await req.runtime.documents.get('Actor', actorId);
        if (!actor) return error('not_found', 'Actor not found');

        await req.runtime.documents.patch('Actor', actorId, {
            'system.level.value': body.targetLevel,
        });

        return json({ success: true });
    } catch (err) {
        return error('internal', getErrorMessage(err));
    }
}

export const apiRoutes: ModuleRouteTable = {
    'actor/[id]/level-up': handleLevelUp,
};
```

Routes are matched by pattern. `[segment]` matches any single path segment.

`ModuleServerRequest` provides:

| Property | Description |
|---|---|
| `req.json<T>()` | Parse the request body. |
| `req.method` | HTTP method. |
| `req.url` | Full request URL. |
| `req.headers` | Request headers. |
| `req.userSession` | Requesting Foundry user session, when authenticated. |
| `req.runtime` | Per-request runtime services. |
| `req.getAccessContext()` | Access context for explicit read checks. |

`req.runtime` extends `ModuleRuntime` with user-bound write services:

| Service | Description |
|---|---|
| `documents` | Full document store: `create`, `patch`, `upsert`, `delete`, `commit`, `effects`, and `items`. |
| `rolls` | Dice evaluation via `rolls.roll(formula, label?, options?)`. |
| `tables` | RollTable draws via `tables.draw(uuid, options?)`. |
| `chat` | User-bound chat helpers: `send`, `card`, and `useItem`. |

Document writes default to the request's bound Foundry user. Passing an access
context does not let a route write as some other user; write subject and transport
identity must match the request user. This is the server-side rule that preserves
Foundry permission enforcement.

---

## Utility Functions

The shared SDK exports pure utilities:

```ts
import {
    getErrorMessage,
    resolveImage,
    processHtmlContent,
    getSafeDescription,
    simulateRoll,
    simulateTableDraw,
    parseRollResult,
    buildModuleAssetUrl,
} from '@sheet-delver/sdk';
```

| Function | Description |
|---|---|
| `getErrorMessage(error)` | Safe error message extraction for catch blocks. |
| `resolveImage(path, baseUrl?)` | Resolve Foundry-relative image paths. |
| `processHtmlContent(html, baseUrl?)` | Fix relative `src=` attributes in Foundry-enriched HTML. |
| `getSafeDescription(system)` | Extract a description string from common Foundry system shapes. |
| `simulateRoll(formula, rollOverride?)` | Local dice simulation for simple formulas. |
| `simulateTableDraw(table, options?)` | Simulate a draw from a fetched RollTable document. |
| `parseRollResult(result)` | Normalize roll output for chat-card rendering. |
| `buildModuleAssetUrl(moduleId, assetPath)` | Build a platform module asset URL. |

---

## Packaging

Use the built-in packaging command:

```sh
npm run module:package <moduleId>
```

The packager:

1. Runs `module:check` first. A non-conforming local module is not packageable.
2. Compiles `logic`, `ui`, and optional `server` entries with esbuild using the
   shared build config from `src/scripts/tools/modules/build-config.ts`.
3. Externalizes the SDK family and React peers. The host provides them at runtime.
4. Writes patched artifact metadata with manifest entries pointing to `dist/*.js`.
5. Compiles `src/styles/tailwind.css`, when present, into
   `assets/<moduleId>.tailwind.css` and records it as `compiledStyles`.
6. Archives `dist/`, `assets/`, `info.json`, optional `LICENSE` / `README.md`,
   and `package.include` entries into `<DATA_DIR>/dist/modules/<id>-<version>.tgz`.

The source directory and source `info.json` are never modified by packaging.

### Static Assets

Static files should live under `assets/`. CSS listed in the UI manifest's
`stylesheet` field must be under `assets/` and is injected when the module mounts.

For non-standard files or directories, declare them in source `info.json`:

```json
{
  "package": {
    "include": ["data/", "templates/"]
  }
}
```

To include source maps:

```sh
npm run module:package <moduleId> -- --sourcemap
```

---

## Checking

Use the built-in checker before packaging or publishing:

```sh
npm run module:check <moduleId>
```

The checker validates SDK compliance and package readiness for modules under
`<DATA_DIR>/local/modules/`.

It checks:

1. `info.json` shape and compatibility constraints.
2. Manifest entry resolution for `logic`, `ui`, and optional `server`.
3. Export shape: logic exports `Adapter`, UI has a default manifest export, and
   server exports a static `apiRoutes` table.
4. SDK import boundaries. Module code imports public SDK entry points only.
5. Logger discipline. Module code uses SDK/platform loggers instead of `console.*`.
6. TypeScript with the module's `tsconfig.json`, when present.
7. Tailwind setup, CSS scope safety, and packageable static CSS dependencies.
8. Static CSS under `assets/` does not use remote HTTP(S) dependencies and every
   local or module-asset-API reference resolves beneath `assets/`.
9. Dry esbuild bundles using the same externals and loaders as packaging.

When it finds legacy imports, it prints migration hints such as:

- `useSDK()` / `useSDKComponents()` from `@sheet-delver/sdk/react`
- `ModuleServerRequest` and route helpers from `@sheet-delver/sdk/server`
- `req.runtime.documents` / `req.runtime.chat` instead of `req.foundryClient`
- SDK utility exports from `@sheet-delver/sdk`

For CI or tooling, emit structured output:

```sh
npm run module:check <moduleId> -- --json
```

---

## Development Workflow

### Module Locations

| Location | Purpose | Lifecycle owned? |
|---|---|---|
| `<DATA_DIR>/local/modules/` | Local dev source. | No |
| `<DATA_DIR>/modules/` | Installed managed artifacts. | Yes |
| `<DATA_DIR>/dist/modules/` | Packaged `.tgz` outputs. | No |

The data directory defaults to `./data` and can be configured with
`--data-dir=<path>` or `SHEET_DELVER_DATA`. The local dev path can be overridden
with `SHEET_DELVER_LOCAL_MODULES`.

Use `<DATA_DIR>/local/modules/` during development. Use
`<DATA_DIR>/modules/` only for installed artifacts managed by the lifecycle
system.

### UI Source Resolution

Local and managed modules are intentionally loaded differently:

| Source | UI loading path |
|---|---|
| Local dev | Explicit imports in generated `.managed/module-ui-registry.ts`; bundled by Next. |
| Managed install | Runtime ESM served by `GET /api/modules/:id/ui`; not bundled by Next. |
| Generic fallback | Host-owned fallback manifest. |

`getUIModule(systemId)` fetches `GET /api/registry/sources` to learn which source
is active. Local dev source resolves through the generated registry. Managed
artifact source resolves through the runtime ESM route. A failing module UI falls
back to the generic manifest so the platform remains usable.

Client-side UI import or evaluation failures are reported back through
`POST /api/modules/:id/ui-error` so lifecycle health can record the runtime
failure for admin review. Server-side artifact read/rewrite failures are recorded
by the UI-serving route itself.

### Server-Side Hot Reload

In local development, the server-side adapter is reloaded when its source file's
mtime changes. On `getAdapter()`, the registry evicts the cached instance and
imports the adapter with a cache-bust query.

This applies to server-side logic. UI component changes are handled by Next's HMR
for local dev modules.

### Source Switching

Only one source for a module should be active at a time. The lifecycle state keeps
local and managed enablement separately so a managed install and a local dev copy
do not overwrite each other's state.

When the active source changes, the server updates lifecycle state and broadcasts
`moduleSourceChanged`. Browser clients invalidate module-source and manifest
caches, then re-resolve the active UI module.

---

## Managed Artifact Health

`module:check` is strict and gates packaging. Managed artifact health is lighter:
an installed module may be old but still loadable.

Blocking errors include:

- Missing required `manifest.ui` or `manifest.logic` artifacts.
- Manifest paths resolving outside the module root.
- Browser UI imports that the runtime ESM loader cannot resolve.

Warnings include:

- Missing optional server or stylesheet artifacts.
- Deprecated SDK names such as `ModuleFoundryClient`, `req.foundryClient`, old
  hook names, or direct private-import references in non-browser code.
- Other survivable drift where the module can still be loaded.

Runtime load failures are also recorded into lifecycle health. This gives an
admin an actionable signal without rejecting every older artifact that still
works.

---

## Migrating an Existing Module

1. Move source to `<DATA_DIR>/local/modules/<systemId>/`.
2. Replace internal platform imports with public SDK entry points.
3. Extend `BaseSystemAdapter` and implement `match(actor)` plus
   `normalizeActorData(actor)`.
4. Replace `ModuleContext` with `ModuleRuntime`; use `runtime.dataStore`,
   `runtime.compendium`, and read-only `runtime.documents`.
5. Replace `req.foundryClient` with `req.runtime` services in server routes.
6. Replace `onActorChanged` with `useSDK().events` or the document hooks.
7. Replace direct `console.*` calls with SDK/platform loggers.
8. Use `actor._stats?.systemId` for authoritative system matching.
9. Resolve images with `resolveImage(path, foundryUrl)` or
   `useSDK().resolveImageUrl(path)`.
10. Run `npm run module:check <systemId>` before packaging.
11. Use `useSDK().navigate()` / `replace()` for internal application routes;
    modules using these UI-extension 1.1 methods must declare
    `ui-extension-api: ">=1.1.0 <2.0.0"`.
