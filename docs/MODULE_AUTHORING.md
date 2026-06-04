# Module Authoring Guide

This guide is the happy path for building a Sheet Delver system module. For the full contract reference, see `src/modules/MODULE_MANIFEST.md`.

## Overview

Modules are developed as local source modules first, then checked and packaged for distribution.

Typical flow:

```bash
git clone git@github.com:sheetdelver/sheetdelver.git
cd sheetdelver
npm ci
npm run setup
npm run module:init my-system "My System"
npm run dev
```

The generated module lives at:

```text
<DATA_DIR>/local/modules/my-system/
```

`<DATA_DIR>` defaults to `./data`, but it may be changed with `--data-dir=<path>` or the `SHEET_DELVER_DATA` environment variable. Pass the same data directory to module tools when you are not using the default:

```bash
npm run module:init my-system "My System" -- --data-dir ./my-data
npm run module:check my-system -- --data-dir ./my-data
npm run module:package my-system -- --data-dir ./my-data
```

During local development, the module can use TypeScript and TSX source files directly. The platform discovers local modules from `<DATA_DIR>/local/modules/<moduleId>` and loads their manifest entries from `info.json`.

## Module Shape

The scaffold creates the expected layout:

```text
<DATA_DIR>/local/modules/my-system/
  assets/
    icon.svg
    styles.css
  info.json
  module/
    logic.ts
    ui.tsx
    server.ts
  src/
    logic/
    ui/
    server/
```

The platform-owned source for this generated tree lives under
`src/scripts/tools/modules/scaffolds/init-module/`.

The three entry points are:

| Entry | Purpose |
|---|---|
| `module/logic.ts` | Exports the system adapter. |
| `module/ui.tsx` | Exports the UI manifest. |
| `module/server.ts` | Optionally exports server API routes. |

All module-facing platform APIs come from the `@sheet-delver/sdk` family, split into four subpath entry points so client code never pulls in server code (and vice versa):

| Entry | Use it for |
|---|---|
| `@sheet-delver/sdk` | Shared, environment-agnostic surface: `BaseSystemAdapter`, the actor/document/card types, and pure utils (`resolveImage`, `parseRollResult`, `buildModuleAssetUrl`, `getErrorMessage`). Safe in any file. |
| `@sheet-delver/sdk/react` | UI surface (client only): `useSDK`, `useSDKComponents`, `useActorSheet`, `useDocument`, `useDocumentMutation`, `useModuleSettings`, `createActorPage`, and the prop interfaces (`ActorSheetProps`, `RichTextEditorProps`, …). |
| `@sheet-delver/sdk/server` | Route surface (server only): the `json()` / `error()` response helpers and the route + runtime types (`ModuleServerRequest`, `ModuleRouteHandler`, `ModuleRequestRuntime`, …). |
| `@sheet-delver/sdk/testing` | A mock host for unit-testing a module against the public contract (`createMockModuleRuntime`, `MockSDKProvider`, …). |

```ts
import { BaseSystemAdapter, resolveImage } from '@sheet-delver/sdk';
import { useSDK, useSDKComponents, useActorSheet } from '@sheet-delver/sdk/react';
import { json, error } from '@sheet-delver/sdk/server';
```

The checker rejects `@sheet-delver/sdk/server` imports from UI (`.tsx`) source — server helpers must not reach the client bundle.

Do not import from Sheet Delver internals such as `@shared/*`, `@client/*`, `@server/*`, `@core/*`, or `@modules/*`. If a module needs something that is not in the SDK, treat that as either a missing SDK surface or module-specific code that should live inside the module.

## Metadata

`info.json` identifies the module and points the platform at the module entry files:

```json
{
  "id": "my-system",
  "version": "0.1.0",
  "title": "My System",
  "manifest": {
    "logic": "module/logic.ts",
    "ui": "module/ui.tsx",
    "server": "module/server.ts"
  },
  "compatibility": {
    "apiContracts": {
      "module-api": ">=1.0.0 <2.0.0",
      "ui-extension-api": ">=1.0.0 <2.0.0",
      "roll-engine-api": ">=1.0.0 <2.0.0"
    }
  },
  "trust": {
    "tier": "first-party"
  }
}
```

Keep `id` aligned with the Foundry system id. The manifest paths are relative to the module root.

## Adapter

The logic entry exports an adapter class. Override only the methods the system needs.

```ts
import {
    BaseSystemAdapter,
    type ActorSheetData,
    type FoundryActor,
} from '@sheet-delver/sdk';

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
            system: actor.system,
            items: actor.items,
            effects: actor.effects,
            derived: {},
        };
    }
}

export default Adapter;
```

If the adapter needs setup, implement `initialize?(runtime: ModuleRuntime)`. The `ModuleRuntime` is a flat, module-scoped handle (no `platform` wrapper): `runtime.logger`, `runtime.foundryUrl`, `runtime.dataStore` (durable backend persistence), `runtime.compendium` (read surface for declared packs), and `runtime.documents` (read-only `get`/`list`/`fetchByUuid`). Use those fields instead of importing platform services directly. An optional `dispose?(runtime)` is called on world teardown.

Adapter projection methods (`normalizeActorData(actor)`, `getActorCardData`, `computeActorData`, `categorizeItems`) receive a hydrated actor document and must be deterministic from it — they take **no** client/runtime argument. Build full image URLs with `resolveImage(img, runtime.foundryUrl)`. The broad Foundry client, the adapter `client` parameters, and `resolveActorNames` were removed; document reads outside projection happen through `runtime.documents`.

Use `fetchByUuid` or compendium lookups only for exceptional linked references that are not already embedded in the actor. Compendium UUID reads are cache-required by default: add the pack to `info.json` under `compendiumPacks.packs` with `hydrate: true` when module code needs full documents. Missing or non-hydrated pack rows return `null` and log a warning. The `foundry.allow-live-compendium-uuid-fallback` / `APP_ALLOW_LIVE_COMPENDIUM_UUID_FALLBACK` setting is a diagnostic operator escape hatch, not a module contract.

## UI

The UI entry exports a `UIModuleManifest`.

```tsx
import type { ModuleInfo, UIModuleManifest } from '@sheet-delver/sdk';
import infoJson from '../info.json';

const info = infoJson as ModuleInfo;

const manifest: UIModuleManifest = {
    info,
    sheet: () => import('../src/ui/Sheet'),
    stylesheet: 'assets/styles.css',
};

export default manifest;
```

`info` is synchronous metadata. Component entries are lazy `() => import(...)` thunks, and each imported component module must provide a default React component export.

A bare `sheet` is enough: the platform wraps it in a default actor page that supplies load / roll / field-update (via `useActorSheet`), shared-content, and an error/loading boundary. Only declare a custom `actorPage: () => import('../src/ui/ActorPage')` when the system needs page-level behavior the default host can't express (e.g. a system-specific roll engine rather than the generic platform roll) — see Mörk Borg for an example.

Inside React components, use the SDK hooks from `@sheet-delver/sdk/react`:

```tsx
import { useSDK, useSDKComponents, useActorSheet } from '@sheet-delver/sdk/react';
import type { ActorSheetProps } from '@sheet-delver/sdk/react';

export default function Sheet({ actor, onRoll, onUpdate }: ActorSheetProps) {
    const { fetchWithAuth, resolveImageUrl, addNotification, assetUrl } = useSDK();
    const { RollDialog, RichTextEditor } = useSDKComponents();

    return null;
}
```

A presentational sheet receives `ActorSheetProps` from the host; a custom `actorPage` instead calls `useActorSheet(actorId)` itself to drive load / roll / update through the host-owned cache.

### Assets

Reference static assets (images, extra CSS) by URL — do **not** `import logo from './logo.png'`. The bundler ships no binary-asset loader, and the same URL must resolve identically in local dev and packaged builds. Put the file under the module's `assets/` directory and build the URL with the host:

```tsx
const { assetUrl } = useSDK();
<div style={{ backgroundImage: `url(${assetUrl('grunge.png')})` }} />
```

`assetUrl(path)` is bound to the current module's id; outside a component, `buildModuleAssetUrl(moduleId, path)` from `@sheet-delver/sdk` produces the same `/api/modules/<id>/assets/<path>` URL. The module's declared `stylesheet` is injected by the platform via that same route. Author CSS scoped under the surface root (`.sdk-module--<id>`); the checker fails on global selector leaks.

## Server Routes

A server entry is optional — generic actor read / field-update / item CRUD are served by the platform `/api/actors` surface, so only export `apiRoutes` for routes that have **no** core equivalent (a system-specific roll engine, table draws, character generation, etc.). `apiRoutes` is a static object keyed by route pattern (`[id]` segments are captured as params); the platform matches and dispatches it.

```ts
import type { ModuleServerRequest, ModuleServerParams } from '@sheet-delver/sdk/server';
import { json, error } from '@sheet-delver/sdk/server';

export const apiRoutes = {
    'actors/[id]/ping': async (req: ModuleServerRequest, { params }: ModuleServerParams) => {
        const { route } = await params;          // ['actors', '<id>', 'ping']
        const body = await req.json<{ note?: string }>().catch(() => ({}));
        const actor = await req.runtime.documents.get('Actor', route[1]);
        if (!actor) return error('not_found', 'Actor not found');
        return json({ ok: true, note: body.note });
    },
};
```

Two things to get right:

- `req.json()` reads the **request body**; it is not a response. Build responses with the `json(payload, status?)` / `error(code, message)` helpers from `@sheet-delver/sdk/server` (the latter maps an `SdkErrorCode` to an HTTP status).
- There is no Foundry client on the request. All host access is through `req.runtime` — the per-request `ModuleRequestRuntime`, which extends the base runtime with the **write** surfaces: `documents` (CRUD + `commit` + `effects` + embedded `items`), `rolls`, `tables`, and `chat`. These are user-bound and default to the caller; pass `{ access }` to act as another subject. Reads/writes are ownership-gated and fail closed.

Routes are exposed under:

```text
/api/modules/<moduleId>/<route>
```

## Checking a Module

Run the SDK/package readiness checker before committing module work:

```bash
npm run module:check my-system
```

The checker validates:

| Check | What it catches |
|---|---|
| Manifest shape | Missing metadata, invalid compatibility, bad package declarations. |
| Entry resolution | Missing logic, UI, or server entry files. |
| Export shape | Missing adapter, UI manifest, or server route exports. |
| SDK boundaries | Internal platform imports that should move to `@sheet-delver/sdk`. |
| TypeScript | Type errors in the module source. |
| Dry bundle | Packaging failures before creating an archive. |

For machine-readable output:

```bash
npm run module:check my-system -- --json
```

The extra `--` is npm's argument-forwarding separator. If you invoke the script directly with `npx tsx`, use `--json` without the separator.

## Packaging

After the module passes the checker, create a distributable artifact:

```bash
npm run module:package my-system
```

Packaging compiles the declared entry points, externalizes host-provided dependencies such as React and `@sheet-delver/sdk`, copies package assets, and writes an archive under the configured data directory.

## CI

`module:init` creates a starter workflow under `.github/workflows/` in the generated module. Keep that workflow with the module repository so module changes are validated where they are made.

A module workflow should check out Sheet Delver as the host SDK/platform, place the module under `${SHEET_DELVER_DATA}/local/modules/<moduleId>`, install dependencies, then run:

```bash
npm run module:check <moduleId>
npm run module:package <moduleId>
```

The Sheet Delver repository should keep CI focused on SDK integrity, scaffold integrity, and platform tests.
