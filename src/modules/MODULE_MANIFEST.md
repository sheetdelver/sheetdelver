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
  "conflicts": []
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
| `compatibility.apiContracts` | No | SemVer range requirements against the platform SDK contracts. |
| `discovery.packs` | No | Compendium packs to index at world-ready time. Declared packs are fully hydrated by the platform before `initialize()` is called. |
| `trust.tier` | No | `first-party` \| `verified-third-party` \| `unverified` |

---

## `module/logic.ts` — The Adapter

Export a class named `Adapter` that extends `BaseSystemAdapter`.

```ts
import { BaseSystemAdapter, type ModuleContext, type FoundryActor, type ActorSheetData } from '@sheet-delver/sdk';

export class Adapter extends BaseSystemAdapter {
    systemId = 'my-system';

    override normalizeActorData(actor: FoundryActor): ActorSheetData {
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

    override match(actor: FoundryActor): boolean {
        return actor.type === 'character' && !!actor.system?.systemSpecificField;
    }

    override async initialize(context: ModuleContext): Promise<void> {
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

**Note on `initialize(context)`:** The platform runs discovery sync (`getDiscoveryConfig()`) before calling `initialize()`. By the time `initialize()` is called, all declared compendium packs are already hydrated in the platform cache and accessible via `context.platform.discovery`. Adapters should read from the context rather than fetching via a client during initialization.

---

## `module/ui.tsx` — The UI Manifest

Export a `UIModuleManifest` as the default export.

```ts
import type { UIModuleManifest } from '@sheet-delver/sdk';
import info from '../info.json';

const manifest: UIModuleManifest = {
    info,
    sheet: () => import('../src/ui/MySheet'),
    rollModal: () => import('../src/ui/MyInitiativeModal'),
    actorPage: () => import('../src/ui/pages/ActorPage'),
    tools: {
        'generator': () => import('../src/ui/tools/Generator'),
    },
    dashboardTools: () => import('../src/ui/MyDashboardTools'),
};

export default manifest;
```

All entries are lazy `() => import(...)` thunks. The platform calls them on demand. The imported module must have a default export that is a React component.

**Platform UI hooks available in module components** (import the type, use the platform's hook implementation):

| Hook type | Interface | Provides |
|---|---|---|
| `UseFoundry` | `import type { UseFoundry }` | `token`, `currentUser`, `system`, `isConnected`, `baseUrl` |
| `UseUI` | `import type { UseUI }` | `isDiceTrayOpen`, `toggleDiceTray`, `isChatOpen`, `setChatOpen` |
| `UseNotifications` | `import type { UseNotifications }` | `addNotification(message, type?, options?)` |
| `UseConfig` | `import type { UseConfig }` | `foundryUrl`, `setFoundryUrl`, `resolveImageUrl` |

**Platform UI components available in module sheets** (import directly from `@client/ui/components/` during development):

`LoadingModal`, `RollDialog`, `ConfirmationModal`, `SharedContentModal`, `RichTextEditor`

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

Available as `req.foundryClient` in API route handlers. Pre-authenticated and scoped to the requesting user's session. The underlying socket connection is fully managed by the platform — modules interact through the methods above only.

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
