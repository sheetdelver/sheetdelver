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

ADR-0062 moves shared image/journal presentation to Core's persistent player
layout. Its SDK `SharedContentModal` export remains callable and renders
nothing when that host is present, so existing module mounts do not duplicate
the overlay. A module removing its mount must require the Core release that
provides the host; older Core releases still depend on the module mount on
sheet pages. Shadowdark and Mörk Borg retain their SDK mounts for those older
Core versions. Core 0.16.0 first provided module-api 1.3; Shadowdark targets the
user-approved Core 0.17.0 minimum and CI/release toolchain for this branch.
Mörk Borg's Core 0.14.2 minimum is unchanged. Validate companion modules with
the pinned release and an isolated data directory, not only Core's root check:
the root `data/` exclusion can omit module-only logic/tests from typechecking.

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
      "ui-extension-api": ">=3.0.0 <4.0.0",
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

## Shared UI Themes

SDK 1.5.0 / `ui-extension-api` 1.3.0 adds optional `theme` and
`componentStyles` to the UI manifest. Export presentation there, not from the
server adapter: callbacks such as `msgContainer`, `rollModeBtn` and `advBtn`
cannot survive JSON status transport. The active UI manifest owns these
callbacks, and Core applies the module's CSS scope to shared chat, previews and
dice trays. Keep server imports out of this client entry.

```ts
const uiManifest: UIModuleManifest = {
    info,
    componentStyles: myTheme,
    sheet: () => import('../src/ui/Sheet'),
};
```

These fields originated in UI contract 1.3.0. SDK 2.2.0 lifecycle behavior requires
`"ui-extension-api": ">=2.1.0 <3.0.0"` and must
pin CI/release tooling to a released Core that supports it. See
[ADR-0044](adr/0044-client-owned-module-presentation.md).

## Core-rendered dashboard actions

SDK 2.0.0 / `ui-extension-api` 2.0.0 gives the dashboard's presentation back
to Core. In `module/ui.tsx`, declare `dashboardActions` with a stable ID,
label, optional description, and either a `toolId` from the manifest's `tools`
map or a lazy dialog component:

```tsx
const uiManifest: UIModuleManifest = {
    info,
    sheet: () => import('../src/ui/Sheet'),
    tools: { generator: () => import('../src/ui/tools/Generator') },
    dashboardActions: [
        { id: 'generator', label: 'Character Generator',
          kind: 'tool', toolId: 'generator' },
        { id: 'importer', label: 'Import Character',
          kind: 'dialog', dialog: () => import('../src/ui/ImportDashboardDialog') },
    ],
};
```

The dialog component accepts `{ onClose(): void }` and may use `useSDK()` to
navigate after completion. Core renders the cards in its own light/dark theme;
the module keeps control of the full tool page and dialog content. Do not use
the removed `dashboardTools`/`dashboardLoading` entries or rely on the old
dashboard `theme`, `token`, and loading setter props. Declare
`"ui-extension-api": ">=2.0.0 <3.0.0"` and a `coreVersion` range beginning
with the first SheetDelver release carrying SDK 2.0.0. See
[Module Manifest Reference](MODULE_MANIFEST.md#dashboard-actions-sdk-200) for
bounds and [ADR-0054](adr/0054-core-rendered-module-dashboard-actions.md)
for the ownership decision.

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

For the Core GM Combat Manager, declare optional `combatTracking.attributes`
in `info.json` when the module has useful combat-stat defaults. Descriptors
name bounded, read-only `system.*` or `derived.*` prepared Actor paths; the GM
may override their selection for the current world. They are independent of
dashboard card blocks and of Foundry's one configured tracker resource. Use
optional `showInRoster: true` only for concise defaults worth showing beside
every combatant name; the GM can change that placement. See
[Module Manifest](MODULE_MANIFEST.md#infojson-schema) and ADR-0049.

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

Keep page/tool headers in normal flow beneath the Core combat HUD. Do not
place a competing fixed `top: 0` header, assume a HUD height or inspect Core DOM.
Existing measured footer registration remains the bottom-navigation contract.

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
`module:check` rejects those hard-navigation forms. Navigation first appeared
in UI contract 1.1.0; modules targeting the next host release declare
`ui-extension-api: ">=3.0.0 <4.0.0"` in `info.json` for Core 0.18.0.

### Combat-HUD initiative presentation (SDK 3.0.0)

The optional UI-manifest `rollModal` is now a typed initiative presentation
slot. Its `InitiativeRollModalProps` include Core's resolved formula/source,
allowed roll and advantage modes, manual-final-total availability, effective
audience, display name, open/close state and a bounded `onConfirm` choice.
Resolution is explicit saved GM override → module `getInitiativeFormula` →
Core `1d20`. Clearing the override restores module-first behavior. Core
validates GM expressions before saving and before execution; it does not
reinterpret a module's formula references or invoke the module hook when an
explicit override exists. Module hooks must use their prepared Actor model and
return an executable formula; the modal must display that supplied formula.
Modules must not recalculate or submit a formula, set recipients, or call a
Foundry transport from this modal. Use the injected SDK `RollDialog` with
`type="initiative"` to retain a module theme, or omit `rollModal` for Core's
generic fallback. Sheet-oriented `RollDialog` modes remain available.

The Combat Manager separately owns GM stat/formula configuration: selected
stat counts are not limited by the module's at-most-16 suggestion contract.
Its numeric reference picker uses observed prepared fields; advanced custom
paths are verified by Core without module-specific schema code or transports.
Do not assume that a catalog suggestion is available on every participant.
HUD initiative uses the same typed dialog callback for candidates outside the
turn roster. Stat presentation is separate from source-backed write authority.

SDK3.2.0/module-api1.4.0 adds optional textarea, `contentFormat` (plain/HTML)
and validated detail `layout` to `info.json` suggestions. See the manifest guide
for exact ranges/defaults. Adopt with module-api>=1.4.0 and target Core>=0.18.0
before publication; existing number/text/resource declarations remain valid
without changes. New defaults seed an unconfigured selection or explicit Reset;
GM-saved selections win. Core authorizes, sanitizes and renders static HTML
using its shared boundary; modules must not add private host imports, native
enrichers, transports or text-write behavior for this presentation. Textarea is
detail-only, not health/editable/HUD/pill data. No current module manifest or
release version has changed to adopt these fields.

For an isolated local test against this unreleased Core branch, a module may
retain its existing temporary development Core minimum while declaring
module-api>=1.4.0; released0.17.x still fails that contract gate. Restore the
Core>=0.18.0 minimum before publication. Do not alter published compatibility
merely to make a development fixture visible.

Upgrade module compatibility to `coreVersion >=0.18.0` and
`ui-extension-api >=3.0.0 <4.0.0`; publish Core before module releases.
For local development against the unreleased Core branch, a temporary
`coreVersion >=0.17.0` minimum can keep the module visible; the 3.x UI API
gate still rejects released Core 0.17.x. Preserve any higher existing minimum
(Mörk Borg's footer requires `>=0.17.1`). Restore the Core 0.18.0 minimum
after that host release and before publishing the module. SDK 3.1.0 /
`ui-extension-api` 3.1.0 makes `InitiativeRollChoice`'s `advantageMode`
optional for `kind: "roll"`. Omit it for the default button: Core executes
the displayed resolved formula unchanged, including module-provided
keep-highest/lowest terms. Explicit `normal`, `advantage` and `disadvantage`
remain bounded leading-d20 overrides. Existing 3.x-compatible modules need
no new minimum range merely for this additive choice; wrappers using the
injected Core `RollDialog` inherit the corrected behavior. The HUD uses the
same slot for an eligible owned row during a GM-opened managed initiative
phase (ADR-0061); authorization and transport remain Core-owned.
Reuse the existing sheet roller's presentation: injected `RollDialog` shares
its frame/theme between sheet and initiative modes. A module with its own
sheet modal can register a typed `rollModal` adapter around reusable module
frame/field/button components (Mörk Borg and D&D do this). Do not reuse sheet
rule execution, bonus/formula editing, recipient selection or raw-die manual
math in that adapter: `kind: "manual"` is already the final total. Theme
classes own their surfaces; Core must not add a conflicting skin. No additional
SDK surface is needed for this presentation reuse.

### Player-world lifecycle

Core's player layout owns login, startup, world-close and transient-outage
presentation for home, Actor and module-tool routes. A module page should not
poll `/api/status` or `/api/session/connect`, redirect for world state, or
present its own global “world starting” screen. It may use SDK `isConnected`
to defer or repeat a module-specific resource read, but Core's overlay blocks
interaction during a same-world interruption. Keep last-rendered sheet/tool
content mounted where practical; treat HTTP 503 and network failures as
temporary unavailability, never as proof that an Actor was deleted. Only a
confirmed 404 should show the module's missing-Actor presentation.

SDK `connection:changed` reports transport health. Since UI contract 2.1.0,
`world:teardown` is reserved for confirmed setup/closure or authenticated
world replacement, and `world:ready` announces an established world after
startup or replacement. A same-world socket blip is not world teardown. See
[ADR-0057](adr/0057-core-player-world-state-boundary.md).

### Optional bottom navigation

SDK 2.3.0 / `ui-extension-api` 2.2.0 adds an opt-in clearance contract for a
module-owned fixed footer, retained in SDK/UI 3.1. Import only the public hook and register the bar
element, not a measured number or a private Core selector:

```tsx
import { useRef } from 'react';
import { useBottomNavigation } from '@sheet-delver/sdk/react';

function MobileSections() {
    const bar = useRef<HTMLElement>(null);
    useBottomNavigation(bar);
    return <nav ref={bar} className="fixed bottom-0 left-0 right-0 sm:hidden">
        {/* Module-owned controls, styling and safe-area padding. */}
    </nav>;
}
```

Core measures the connected, visible element only while it meets the viewport
bottom. Its Tools, Chat, Players and player feedback reserve the largest active
bar height. Hidden responsive bars reserve nothing; without a registration,
Core placement stays unchanged. The hook releases on unmount/ref/provider
change, and Core retires registrations with the module/world/user or terminal
UI scope. Mount the hook with the bar (rather than conditionally rendering only
the ref target) so its lifecycle matches the element. Module colors and layout
remain module-owned; do not set Core's internal CSS variable directly.

The imperative `useSDK().registerBottomNavigation(element)` returns an
idempotent disposer; custom consumers must call it on cleanup. Mock SDK hosts
provide an inert registration. Adopting modules require
`"ui-extension-api": ">=2.2.0 <3.0.0"` and a released Core supporting it
(Core 0.17.1 in ADR-0062). HUD modules use the combined UI 3.x contract
(`>=3.0.0 <4.0.0`) and the Core 0.18.0 publication gate above; do not revert
them to UI 2.x merely to retain footer support. Modules not using the addition need no minimum
bump. Before publication, pin CI/packaging to that available release tag and
align the application minimum; never ship a local-development staging minimum
as a substitute for release validation.

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

## CI and independent module releases

`module:init` creates module-owned validation/release workflows, a standalone
`scripts/release.mjs`, its tests, a command-only npm manifest, initial changelog
and `docs/RELEASING.md`. The helper has no dependency on Core or another module.
`info.json` remains the only module version authority.

- `ci-<moduleId>.yaml` checks pull requests, `main` pushes, pushed `v*` tags and
  manual runs. It runs the standalone helper tests, then validates/packages the
  module against its pinned Core toolchain in an isolated data directory.
- `release-<moduleId>.yaml` runs only on an explicitly confirmed workflow dispatch
  at the version tag. A read-only verification job requires successful push CI
  for that exact tag/commit before calling the existing pinned reusable build.

From the module repository, after preparing the numbered release in its changelog:

```sh
npm run release:tag -- --dry-run
npm run release:tag
npm run test:release
```

An optional version must match that changelog section. The helper prepares the
manifest version and annotated tag, asks to push main/tag, waits for tag CI, and
asks separately to publish. It supports local-only preparation and resuming an
interrupted run without replacing tags. Commit the helper/workflow changes to the
default branch before using it. See the generated release guide for prerequisites
and exact recovery behavior. Ordinary CI and tag pushes do not publish releases
under the new wrappers.

The reusable build still publishes the archive, checksum, stable manifest and
release history, using the module's tested Core pin. The release history retains
each version's compatibility declarations; authors do not maintain it by hand.
Core owns scaffold/platform tests; modules own validation and release runs. No
module or Core version bump is implied by editing release tooling.

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

Notification lifecycle first appeared in UI contract 1.2.0. Modules targeting
the next host release declare `"ui-extension-api": ">=3.0.0 <4.0.0"`.
Notification IDs are ephemeral;
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

## Native world settings and data maintenance

[Core ADR-0064](adr/0064-module-world-context-and-data-migrations.md) is released
through Core 0.19.1, with SDK 3.4.0/module-api 1.6.0/UI 3.2.0. See
[the authoring contract](MODULE_MIGRATIONS.md) and its
[compatibility requirements](MODULE_MIGRATIONS.md#compatibility-and-adoption).
Bounded `reads.relations` require module-api 1.6; existing catalogs retain their
1.5 introduction floor. Core 0.18.1 lacks these contracts.

The [four-issue G8 correction amendment](adr/0064-module-world-context-and-data-migrations.md#g8-integration-correction-amendment--october-18-2026)
tracks CG-7 pack defaults, CG-9 access-driven refresh, CG-10 managed SDK errors and
CG-5 shared roll-dialog keyboard behavior. They are not fixed in 0.19.1. Module
work is held for the supporting point release; the selected Core implementation,
independent/native acceptance and responsive UI follow-up are closed.
Keep module requirements and historical hooks unchanged during that Core task;
choose the published supporting minimum and CI/release pins during later module
resumption. Do not work around these findings with advisory required migrations,
privileged reads, polling, message-based error classification or duplicated UI.
CG-5 is not a migration blocker. The prior native Core evidence does not establish
full module acceptance.

The current Core correction preserves existing archives and public contracts.
Subscribe to the existing `world:contextChanged` signal for caller-dependent
collections even when `keys` is empty: retire loaded values and pending responses
before refetching, retaining search/tab intent. Ownership configuration is never
exposed to module UI. Do not use an unrelated setting as a refresh trigger.
Use `isSdkError`, not `instanceof`, across host/module loaders. Recognition uses
the SDK's non-wire brand, actual Error identity and validated code/error status;
arbitrary objects and internal exceptions remain sanitized failures. No module
repackaging, historical-hook rewrite or SDK/API contract bump is needed for these
implementation corrections. Adoption still waits for the supporting Core release;
select its actual application minimum in the later module-owned task.

`useModuleSettings` does not expose native world settings, and
adapter initialization cannot write documents. A registered default is not proof
of an unreadable world's value. The world context updates to a new
immutable revision when a GM changes a declared Foundry setting.

Declare `info.json.worldSettings` with exact native keys, schemas, versioned default
provenance and exposure. Preparation consumes `context.world`; request handlers
use `runtime.world`; UI uses authorized prepared data or `useWorldSetting` from
`@sheet-delver/sdk/react`. Refresh dependencies through `onWorldContextChanged`
before prepared rebuilds, and fence setting-dependent actions with their context
revision. Keep unavailable results distinct from stored and registered defaults.

Implement `getSystemDataForUser` using its supplied caller-bound runtime. Non-full-GM
`/api/system/data` returns 403 without it. Apply effective pack capabilities to
all collections, indexes and resource routes; do not publish privileged warmed
caches or infer access from pack hydration. Preserve canonical UUIDs and use
authorized `referenceLabels` only for display.

For migrations, authors maintain a separate root `migration.json` catalog,
version directories with `definition.json`, and pure check/plan/verify hooks such
as `actor-migrations.ts`. Keys denote native game-system versions, not SheetDelver
module or Foundry platform versions. Definitions constrain affected targets/paths
and dependencies; hooks handle edge cases and return operations for Core execution.
The packager compiles referenced logic and validates all entries. Do not put the
migration catalog or logic paths in `info.json` or duplicate it in release metadata.
Already-packaged managed hooks are copied, not recompiled for same-version repair.
Core binds reference membership/content as well as target source to the approval;
declare every dependency rather than relying on undeclared caches. Declared read
packs are content-fenced by Core as soon as accepted ingress arrives, including
before adapter initialization; listing them in ordinary `compendiumPacks` is not
required for this migration fence. A retired snapshot cannot authorize obsolete
writes, and changed dependencies require fresh admin review. Dependency hooks
must settle after errors/timeouts: the host cannot cancel their JavaScript and will
hold subsequent preparation until settlement or a Core restart.

Core's corrective workflow persists maintenance and stops normal workers first,
then reviews the complete authoritative plan and backup-warning acknowledgement.
An online preview is advisory, not write approval. Core handles
transport, progress, restart recovery and activation. Every bootstrap/reconciliation
checks required postconditions against fresh source; an externally restored world
can require admin repair even when the local journal says completed. Modules get
no privileged write runtime, sheet repair fallback or native user lockout control.
SheetDelver supplies no world backup/restore or migration undo in this scope.

Keep historical steps needed for supported skipped-version upgrades and test
restored/mixed/custom data. First install, source switch and later world activation
also require checks. Ordinary startup cannot authorize new repairs. The settings/
reference refresh contract is required for same-world recovery, which does
not rerun adapter initialization. Module adoption is separately authorized G8.

Core's configured Foundry service account must be full **Gamemaster** in each world.
ADR-0064 G0a requires connection/reconnect/demotion checks before module readiness;
that enforcement shipped in 0.19.0. Modules must not handle this with
privileged fallbacks or apply the service-account rule to human Assistant users.
See [operator configuration](CONFIGURATION.md#service-account-role-and-recovery).
