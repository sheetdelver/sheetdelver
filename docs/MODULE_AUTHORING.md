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

The three entry points are:

| Entry | Purpose |
|---|---|
| `module/logic.ts` | Exports the system adapter. |
| `module/ui.tsx` | Exports the UI manifest. |
| `module/server.ts` | Optionally exports server API routes. |

All module-facing platform APIs come from:

```ts
import { BaseSystemAdapter, useSDK, useSDKComponents } from '@sheet-delver/sdk';
```

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

The platform provides `context.logger`, `context.platform.cache`, and `context.platform.compendiumPacks` through `initialize(context)`. Use those context fields instead of importing platform services directly.

Adapter methods receive hydrated actor documents from the platform actor cache. Keep actor projection methods (`getActorCardData`, `normalizeActorData`, `computeActorData`, `categorizeItems`) deterministic from the actor they receive and the already-injected SDK services. The `getActor()` and `getActors()` SDK/request methods remain the public read surface, but they resolve from the platform actor cache and fail as not-ready before bootstrap completes; they must not repeatedly fetch from Foundry.

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
    actorPage: () => import('../src/ui/ActorPage'),
    stylesheet: 'assets/styles.css',
};

export default manifest;
```

`info` is synchronous metadata. Component entries are lazy `() => import(...)` thunks, and each imported component module must provide a default React component export.

Inside React components, use SDK hooks:

```tsx
import { useSDK, useSDKComponents } from '@sheet-delver/sdk';

export default function Sheet() {
    const { fetchWithAuth, resolveImageUrl, addNotification } = useSDK();
    const { RollDialog, RichTextEditor } = useSDKComponents();

    return null;
}
```

## Server Routes

If the module has server-side routes, export `apiRoutes` from the server entry.

```ts
import type { ModuleServerRoute } from '@sheet-delver/sdk';

export const apiRoutes: Record<string, ModuleServerRoute> = {
    async ping(req) {
        return req.json({ ok: true });
    },
};
```

Routes are exposed under:

```text
/api/modules/<moduleId>/<route>
```

Prefer narrow route handlers that use the SDK request object and injected Foundry client instead of importing server internals.

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
