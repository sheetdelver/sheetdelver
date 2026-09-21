# Module Authoring Guide

This guide is the happy path for building a Sheet Delver system module. For the full contract reference, see `MODULE_MANIFEST.md`.

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

The generated workflows pin Sheet Delver to the release matching the root
`package.json` version. When intentionally scaffolding from an unreleased but
pushed development branch, override that ref explicitly:

```bash
npm run module:init my-system "My System" -- --core-ref manifest-module-distribution
```

Before publishing the module, replace a development branch ref with the tested
Sheet Delver release tag. CI and releases must not silently follow a moving core
branch.

During local development, the module can use TypeScript and TSX source files directly. The platform discovers local modules from `<DATA_DIR>/local/modules/<moduleId>` and loads their manifest entries from `info.json`.

## Module Shape

The scaffold creates the expected layout:

```text
<DATA_DIR>/local/modules/my-system/
  .github/
    workflows/
      ci-my-system.yaml
      release-my-system.yaml
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
Managed module UI runs as native browser ESM outside the host Next.js build. Module source must not import `next` or `next/*`; use React, browser APIs, or `@sheet-delver/sdk/react` instead. `module:check` rejects this host-framework coupling before packaging.

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
      "module-api": ">=1.1.0 <2.0.0",
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

The module `version` and API contract ranges describe different things.
`version` is the module's own release. Each
`compatibility.apiContracts` entry declares which host contract versions the
module can consume. Declare only ranges the module actually supports, and raise
the minimum version when adopting a newly added SDK method.

Contract versions follow semantic versioning: patches preserve the public
shape, minors add backward-compatible behavior, and majors may break existing
consumers. They are independent of the Sheet Delver application version and the
module version. The host's canonical values are maintained in
`src/shared/sdk/contractVersions.ts` and exposed publicly through
`SDK_VERSION` and `API_CONTRACT_VERSIONS` from `@sheet-delver/sdk`;
modules must not import the host's internal source file.

## Adapter

The logic entry exports an adapter class. Override only the methods the system needs.

```ts
import {
    BaseSystemAdapter,
    type ActorPreparationContext,
    type FoundryActor,
    type PreparedActorData,
} from '@sheet-delver/sdk';

export class Adapter extends BaseSystemAdapter {
    systemId = 'my-system';

    match(actor: FoundryActor): boolean {
        return actor._stats?.systemId === this.systemId;
    }

    prepareActorData(
        actor: FoundryActor,
        context: Readonly<ActorPreparationContext>,
    ): PreparedActorData {
        const prepared = super.prepareActorData(actor, context);
        return {
            ...prepared,
            derived: {
                ...prepared.derived,
                itemCount: prepared.items.length,
            },
        };
    }
}

export default Adapter;
```

If the adapter needs setup, implement `initialize?(runtime: ModuleRuntime)`. Core calls it exactly once per active-world epoch, after declared compendium packs are hydrated and primary document Stores are seeded. Registry discovery and adapter resolution never initialize module code. The `ModuleRuntime` is a flat, module-scoped handle (no `platform` wrapper): `runtime.logger`, `runtime.foundryUrl`, `runtime.dataStore` (durable backend persistence), `runtime.compendium` (read surface for declared packs), and `runtime.documents` (read-only `get`/`list`/`fetchByUuid`). Use those fields instead of importing platform services directly. An optional `dispose?(runtime)` is called on world teardown with the same runtime instance.

Changes to executable module state (enable, disable, source switch, install, upgrade, or uninstall) use a supervised application restart so the next adapter instance enters through that complete bootstrap sequence. The application shell may still refresh local UI code during development, but changes to server adapter logic require restarting `npm run dev`.

`prepareActorData(actor, context)` is the canonical Actor preparation hook. Core
calls it synchronously once per source Actor revision, after adapter initialization,
and shares that prepared revision with actor lists, cards, sheets, rolls, and combat
initiative. The input is a defensive source clone and the context is immutable.
Preparation must be deterministic and user-invariant: do not perform transport,
filesystem, clock, random, session, or request-specific work in this hook.

Load compendium/configuration dependencies during `initialize(runtime)` and retain
stable module state for preparation. `runtime.documents` remains explicitly
source-shaped; it does not expose Foundry client-prepared documents. Authorization
and LIMITED/OBSERVER/OWNER projection remain host concerns outside preparation.

`BaseSystemAdapter.prepareActorData` provides the SDK 1.x compatibility bridge by
composing `normalizeActorData`, `computeActorData`, and `categorizeItems`.
Existing modules may inherit that bridge, but new module logic should treat
`prepareActorData` as the single rules-preparation entry point. Card and roll hooks
receive the resulting prepared Actor. `getActorCardData` may return only
system-specific subtext, stat blocks, and footer content: Core fills omitted
`name` and `img` from the same prepared revision so targeted realtime card
refreshes do not depend on stale list data. Explicit name/image presentation
overrides remain supported. Build full image URLs with
`resolveImage(img, runtime.foundryUrl)` when a module owns image projection.

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

A presentational sheet receives `ActorSheetProps` from the host; its `actor` is
the authorization-bounded projection of the current `PreparedActorData` revision.
A custom `actorPage` instead calls `useActorSheet(actorId)` itself to drive the
same prepared read plus roll / update through the host-owned cache.

### Assets

Reference static assets (images, extra CSS) by URL — do **not** `import logo from './logo.png'`. The bundler ships no binary-asset loader, and the same URL must resolve identically in local dev and packaged builds. Put the file under the module's `assets/` directory and build the URL with the host:

```tsx
const { assetUrl } = useSDK();
<div style={{ backgroundImage: `url(${assetUrl('grunge.png')})` }} />
```

`assetUrl(path)` is bound to the current module's id; outside a component, `buildModuleAssetUrl(moduleId, path)` from `@sheet-delver/sdk` produces the same `/api/modules/<id>/assets/<path>` URL. The module's declared `stylesheet` is injected by the platform via that same route. Core serves assets from the registry-selected source, so local development cannot accidentally borrow files from an older managed package. Author CSS scoped under the surface root (`.sdk-module--<id>`); the checker fails on global selector leaks, remote runtime CSS/font dependencies, and missing or escaping asset references. Self-host runtime CSS dependencies beneath `assets/`.

### Internal navigation

Module UI must use the host-owned router for Sheet Delver routes. This preserves
the application shell, SDK providers, and realtime connection across navigation:

```tsx
const { navigate, replace } = useSDK();

navigate('/tools/my-system/generator'); // add browser history
replace('/');                            // redirect without a stale back entry
```

Targets must be root-relative paths on the current Sheet Delver origin. Use a
normal anchor for an external destination. Do not assign `window.location.href`
or call `window.location.assign()` / `replace()` for internal routes;
`module:check` rejects those hard-navigation forms. Modules using this surface
must require `ui-extension-api: ">=1.1.0 <2.0.0"` in `info.json`.

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
| Static CSS assets | Remote runtime dependencies and missing, escaping, or non-module asset paths. |
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

`module:init` creates two workflows under `.github/workflows/` in the generated
module. Keep them with the module repository:

- `ci-<moduleId>.yaml` checks pull requests, `main` pushes, and manual runs. It
  checks out the pinned Sheet Delver toolchain, stages the module in an isolated
  local-source directory, and runs both validation and packaging.
- `release-<moduleId>.yaml` runs only for pushed `v*` tags and calls Sheet
  Delver's reusable release workflow using the same pinned core ref.

The validation commands are:

```bash
npm run module:check <moduleId>
npm run module:package <moduleId>
```

For a release, update and commit `info.json` first, then create a tag whose value
without the leading `v` exactly matches the module version. The workflow creates
a GitHub Release containing the package archive, checksum, stable
`sheet-delver-manifest.json`, and generated `sheet-delver-releases.json` history.
The history copies each release's compatibility declaration, so only versions
compatible with the running Sheet Delver core and SDK contracts are offered in
the catalog. Authors do not maintain the history file by hand. Ordinary CI never
publishes a release.

The Sheet Delver repository keeps CI focused on SDK integrity, scaffold
integrity, and platform tests. Module repositories own their validation and
release runs.

## Shared Dice Presentation

3D dice are a host-owned presentation feature, not a module responsibility.
Host evaluation supports the bounded [formula grammar](dice-presentation.md#host-formula-evaluation),
including parentheses, pools and min/max. Invalid input rejects instead of
returning zero or posting fallback chat. Do not duplicate this evaluator in modules.

Continue using the host roll API/SDK components or request-bound
`runtime.rolls` and `runtime.chat`. The player shell animates supported evaluated
terms from authorized, live ChatMessage projections; no module animation call,
renderer import, or raw socket listener is needed.

For a silent `runtime.rolls.roll`, pass its serialized `rolls` to raw
`runtime.chat.send({ rolls: result.rolls, ... })`, or use a structured card:

```ts
const result = await req.runtime.rolls.roll('1d20 + 3', 'Ability check');
await req.runtime.chat.card({
    title: 'Ability check',
    evaluatedRolls: result.rolls,
}, { rollMode: 'publicroll', speaker: { actor: actorId } });
```

`ChatCard.evaluatedRolls` requires `module-api >=1.2.0 <2.0.0` (SDK 1.3.0).
Only adopters need to raise their minimum contract. Do not use
`displayChat: true` and also post the same roll as a card: that creates two
independent messages.

`ChatCard.rolls` remains display-only formula/total summaries. They stay in
card flags, never native ChatMessage rolls, and cannot animate dice. Native
rolls take display precedence when both fields are present. Summary-only cards
follow ordinary chat visibility, not native-roll placeholders.

Evaluated rolls require JSON strings with class, formula, finite total,
`evaluated: true`, and a terms array. Invalid card data raises SDK `validation`
before sending. Core never re-evaluates terms or invents faces.
`parseRollResult` normalizes valid transport objects/strings into
`RollResult.rolls`; malformed/summary input supplies no evaluated rolls.
The mock host shares card serialization; its numeric roll stub does not invent
evaluated terms. Self remains chat-only. Blind results animate only for viewers
whose server-projected DTO explicitly permits content visibility. Native recorded
pool, parenthetical and function children use the same bounded host presenter;
modules must not flatten, reroll or implement their own animation hooks.
See [ADR-0042](adr/0042-dice-presentation-followups.md) for supported shapes and limits.
See [ADR-0041](adr/0041-sdk-chat-card-roll-contract.md) for the contract decision.

See [3D Dice Presentation](dice-presentation.md) and
[ADR-0039](adr/0039-client-dice-presentation.md).


## Notifications and Chat Feedback

Use `useSDK()` for application feedback. Text is literal by default; opt-in HTML
is sanitized by the host. Do not implement module-owned toast queues or previews.
There is no separate public `useNotifications()` hook.

With SDK 1.4.0 / `ui-extension-api` 1.2.0, notifications support info, success,
warning and error; options include title, html, duration (milliseconds),
permanent and progress (0-1). Retain the returned ID to update or dismiss:

```tsx
const { addNotification, updateNotification, removeNotification } = useSDK();

async function exportCharacter() {
    const id = addNotification('Preparing export', 'info', { title: 'Export', progress: 0 });
    try {
        await saveExport();
        updateNotification(id, { content: 'Export ready', type: 'success', progress: 1 });
    } catch {
        updateNotification(id, { content: 'Export failed', type: 'error', progress: 1 });
    }
    // For cancellation, use removeNotification(id).
}
```

Declare `"ui-extension-api": ">=1.2.0 <2.0.0"` when using these additions.
Existing add-only modules need no manifest change. Notification IDs are ephemeral;
updates return false after expiry, dismissal or session cleanup. Do not recreate
a notice after a late update fails. Incomplete progress pauses expiry; completion
resumes it unless permanent is true. Only dismiss your own operation's notice.
Host queue clearing, replacement keys and viewport controls are not module APIs.

Tests can inject `createMockNotifications()` from `@sheet-delver/sdk/testing`
via `createMockSdkContext({ overrides: ... })` using its three public methods.
Inspect `getNotifications()` and call `clear()` to simulate cleanup. The fake
records state only, without rendering, sanitization, queue limits or timers.
The default mock SDK also supports IDs, updates and removal.

Post conversations and rolls through the existing request-bound runtime chat
and roll APIs. The host displays authorized ChatMessage documents in the log
and live previews; a notification is not a persisted chat message. Avoid an
additional success toast for a roll already posted to chat. The host's
useActorSheet helper recognizes persisted chat acknowledgements; non-chat
responses and errors retain feedback.

See [Notifications and Chat](NOTIFICATIONS.md) for timing, sanitization and
lifecycle details, and [ADR-0043](adr/0043-sdk-notification-lifecycle.md) for the
contract decision. Notification calls are client-only, never server runtime APIs.
