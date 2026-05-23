# ADR-0010: External Module SDK and Operational Maturity

**Status:** Active — SDK complete. dnd5e migration complete. morkborg and shadowdark pending.
**Date:** May 3, 2026 / Updated May 7, 2026
**Supersedes:** None
**Related:** ADR-0004, ADR-0007, ADR-0008, ADR-0009

---

## Audit Findings: What the Prior Draft Got Wrong

The prior draft described the SDK as entirely future work and overstated architectural coupling. A code audit reveals the following:

**Already built and working:**
- `src/shared/sdk/` — SDK skeleton exists with `BaseSystemAdapter`, `SystemAdapter`, `ModuleContext`, `ModuleLogger`, `FoundryClient`, `UIModuleManifest`, all Foundry document interfaces, and `PersistentCache`/`CompendiumCache` context interfaces.
- The registry (`src/modules/registry/core/server.ts`) already scans both `src/modules/` (built-in) and `data/modules/` (external) and lazily loads modules via `import()` with absolute paths.
- The full module lifecycle system exists — discovered, installed, validated, enabled, disabled, incompatible, errored, with trust policy, artifact verification, permission delta, and dry-run preview.
- `tsx` + `.managed/tsconfig.paths.json` resolves `@shared`, `@core`, `@server`, `@client`, `@modules` at runtime for the server process. This is why external modules in `data/modules/` can import core aliases today without a separate build step.

**What is not yet done — the actual gaps:**

---

## Context

Modules (`shadowdark`, `morkborg`, `dnd5e`) live in `<DATA_DIR>/local/modules/` (local dev source, Mode A) or `<DATA_DIR>/modules/` (managed installs, Mode B artifacts). The data directory defaults to `./data/` and is configured via `--data-dir=<path>` or `SHEET_DELVER_DATA`. The registry discovers and dynamically imports them at startup. In Mode A, `info.json` manifests point to raw TypeScript source files — this works because the server runs via `tsx` and the tsconfig paths resolve across the whole tree. In Mode B, manifests point to pre-compiled `dist/logic.js` and `dist/ui.js` artifacts.

At the time of the original audit, no module used the SDK. Every external module reached into the core via internal path aliases. A full audit of `<DATA_DIR>/local/modules/**` revealed 29 distinct internal import paths:

**Server-side internal imports (modules should not need these):**
- `@core/config` — direct config access
- `@core/foundry` — Foundry client instance
- `@core/foundry/instance` — same
- `@core/foundry/compendium-cache` — compendium access
- `@core/foundry/classes/Roll` — Roll class
- `@core/cache/PersistentCache` — cache implementation
- `@server/shared/types/actors`, `/foundry`, `/moduleProxy`, `/requestContext` — internal request/response types
- `@server/shared/utils/getErrorMessage` — utility
- `@server/shared/utils/getModuleFoundryClient` — pre-authenticated Foundry client injector (the right pattern, but an internal import)
- `@shared/utils/logger` — logging (47 occurrences — the most common import)
- `@shared/interfaces` — duplicates SDK interfaces
- `@shared/contracts/realtime` — realtime event types

**Client-side internal imports (modules reach into core UI):**
- `@client/ui/components/LoadingModal` (20 occurrences)
- `@client/ui/components/RollDialog`
- `@client/ui/components/NotificationSystem`
- `@client/ui/components/ConfirmationModal`
- `@client/ui/components/RichTextEditor`
- `@client/ui/components/SharedContentModal`
- `@client/ui/components/SheetRouter`
- `@client/ui/context/ConfigContext`
- `@client/ui/context/FoundryContext`
- `@client/ui/context/UIContext`

**Cross-module source imports (breaks isolation):**
- `@modules/registry/types` — `UIModuleManifest` (already exists in SDK)
- `@modules/registry/client` — client-side registry queries
- `@modules/generic/src/logic/adapter` — MorkBorg extends generic's `GenericSystemAdapter` instead of `BaseSystemAdapter`
- `@modules/shadowdark/src/logic/actor-enricher` and `/talent-handlers` — morkborg reads shadowdark internals
- `@modules/shadowdark/src/ui/themes/shadowdark` — theme import from another module

**SDK contract wiring not completed:**
- `getAdapter()` in `core/server.ts:1761` calls `adapter.initialize()` without passing a `ModuleContext`. The `ModuleContext` interface exists in the SDK but is never actually injected.
- `UIModuleManifest` is defined in `src/shared/sdk/interfaces.ts` AND re-exported from `@modules/registry/types`. Modules import from the latter — the former is unused by external code.

---

## Decision

We formalize the SDK as the sole import surface for external modules. This is not a new direction — the SDK skeleton and registry are already solid. The work is to close the gaps between the existing SDK and what modules actually need.

### Four Real Work Tracks

---

### Track 1: SDK Surface Completion

**Goal:** Every import a module legitimately needs is available from the SDK without any internal alias.

**Gaps to close:**

**1a. Wire `ModuleContext` injection.**
`getAdapter()` in `src/modules/registry/core/server.ts:1761` currently calls `adapter.initialize()` with no arguments. It must construct a `ModuleContext` and pass it:
```ts
// construct context from platform services
const context: ModuleContext = {
    moduleId: pluginId,
    logger: createModuleLogger(pluginId),
    platform: {
        cache: createScopedPersistentCache(pluginId),
        discovery: createScopedCompendiumCache(pluginId),
    }
};
await adapter.initialize(context);
```
The relevant types already exist in `src/shared/sdk/context.ts`. The platform service implementations exist in `src/server/core/cache/PersistentCache.ts` and `src/server/core/foundry/compendium-cache.ts`.

**1b. Expose `ModuleLogger` as a named re-export and provide a real implementation.**
`src/shared/utils/logger.ts` is the concrete logger. A `createModuleLogger(moduleId)` factory that wraps it with a namespace prefix should live in the registry's module-loading path, not be imported by modules directly.

**1c. Consolidate `UIModuleManifest`.**
The type exists in `src/shared/sdk/interfaces.ts`. It must also be re-exported from `src/modules/registry/types.ts` (it already is via `export type { SystemAdapter, UIModuleManifest }`). Module entry points (`module/ui.tsx`) import from `@modules/registry/types`. That import is acceptable as a registry contract, but the type definition must remain canonical in the SDK — no drift between the two.

**1d. Add server-side API handler types to the SDK.**
`ModuleApiRequest`, `ModuleApiParams`, and `UserSession` already exist in `src/shared/sdk/contracts.ts`. Modules importing `@server/shared/types/requestContext` or `@server/shared/types/moduleProxy` to type their API handlers should use these instead. The SDK types need to be verified to cover the actual shape passed by `ModuleProxyService`.

**Files:** `src/shared/sdk/`, `src/modules/registry/core/server.ts:1747-1773`, `src/modules/registry/core/types.ts`, `src/server/services/modules/ModuleProxyService.ts`

---

### Track 2: UI Component Surface (ui-kit)

**Goal:** Extract the 7 core UI components that modules import into a stable, versioned surface accessible from the SDK path.

This is the biggest gap and the hardest to close. Modules import concrete React components from the core client tree. These components cannot be shipped as types — they are runtime dependencies.

**Components used by external modules:**
| Component | Source | Usage |
|---|---|---|
| `LoadingModal` | `@client/ui/components/LoadingModal` | 20 occurrences |
| `RollDialog` | `@client/ui/components/RollDialog` | Sheet-level roll UI |
| `NotificationSystem` | `@client/ui/components/NotificationSystem` | Toast hooks |
| `ConfirmationModal` | `@client/ui/components/ConfirmationModal` | Destructive action gating |
| `RichTextEditor` | `@client/ui/components/RichTextEditor` | Journal editing |
| `SharedContentModal` | `@client/ui/components/SharedContentModal` | Cross-player sharing |
| `SheetRouter` | `@client/ui/components/SheetRouter` | Tab routing within sheets |

**Resolution:** Create `src/client/ui/module-surface/index.ts` that re-exports these components and hooks under a stable path. This is then aliased so modules can import them consistently. The SDK's `src/shared/sdk/ui.ts` already defines the *prop interfaces* for these components — that is the right level of contract. The actual React components stay in the client tree but are accessed via the surface path.

**Client-side contexts used by modules:**
- `ConfigContext` — system config and base URL
- `FoundryContext` — active Foundry connection state
- `UIContext` — dice tray, chat open/close

The SDK's `UseFoundry`, `UseUI`, and `UseNotifications` interfaces already describe these hooks. A `src/client/ui/module-surface/hooks.ts` file should export the actual `useFoundry()`, `useUI()`, and `useNotifications()` hooks bound to these interfaces.

**Files:** `src/client/ui/components/` (7 components), `src/client/ui/context/`, `src/shared/sdk/ui.ts`

---

### Track 3: Cross-Module and Core Direct-Access Cleanup

**Goal:** Eliminate the imports that break isolation entirely.

**3a. MorkBorg extends generic instead of SDK.**
`data/modules/morkborg/src/server/MorkBorgAdapter.ts` imports `GenericSystemAdapter` from `@modules/generic/src/logic/adapter`. This is a cross-module source import. `BaseSystemAdapter` in the SDK provides the same default behaviors. MorkBorg should extend `BaseSystemAdapter` instead.

**3b. MorkBorg imports shadowdark internals.**
`@modules/shadowdark/src/logic/actor-enricher` and `@modules/shadowdark/src/logic/talent-handlers` are imported by MorkBorg and a shadowdark UI file. This is a hard coupling between two system modules. These imports need to be removed — MorkBorg should carry its own logic.

**3c. Direct `@core/*` access.**
Modules importing `@core/config`, `@core/foundry/instance`, `@core/foundry/compendium-cache`, `@core/cache/PersistentCache`, and `@core/foundry/classes/Roll` are reading core internals. These must be replaced with:
- Config values: passed via `ModuleContext` or a module-specific config surface
- Foundry access: passed via `FoundryClient` (already in SDK) and injected via `ModuleContext`
- PersistentCache: already in `ModuleContext.platform.cache`
- CompendiumCache: already in `ModuleContext.platform.compendiumPacks`
- `Roll` class: should not be used directly in modules — roll operations go through `FoundryClient.roll()`

**Files:** `data/modules/morkborg/src/server/MorkBorgAdapter.ts`, `data/modules/shadowdark/src/server/`, `src/shared/sdk/base.ts`

---

### Track 4: Build Contract Definition

**Goal:** Define what "a valid external module" means at the build level, without requiring a mandatory compiled bundle today.

**Current state:** Modules are raw TypeScript files. `tsx` resolves path aliases at runtime via `.managed/tsconfig.paths.json`. This works for local development. It breaks if a module is installed from a remote source and its TypeScript source is not present, or if the core's path aliases change.

**Decision:** Define two module operating modes:

**Mode A — Source Module (development/trusted):**
- `info.json` manifest points to `.ts` / `.tsx` files
- Module directory contains TypeScript source
- Platform runs it via `tsx` with full alias resolution
- This is the current mode for all three external modules
- Acceptable for trusted, locally-installed modules

**Mode B — Artifact Module (production/remote):**
- `info.json` manifest points to pre-compiled `.js` / `.mjs` files in a `dist/` directory
- The bundle uses only SDK types (no internal aliases to resolve)
- The platform's loader detects `.js` / `.mjs` suffixes and skips `tsx`-specific handling
- Required for modules installed via `index://` or remote sources

The registry's module loader at `src/modules/registry/core/server.ts:376-383` already uses `import(path.join(modulePath, info.manifest.logic))` — Node.js native `import()` handles both `.ts` (via tsx) and `.js` (native). No loader change is needed. The distinction is in what the manifest points to.

Document this in `src/modules/MODULE_MANIFEST.md` with:
- The two modes and their constraints
- The required exports (`Adapter` class, default `UIModuleManifest`, optional `apiRoutes`)
- What SDK version to target (`compatibility.apiContracts`)

**Files:** `src/modules/MODULE_MANIFEST.md`, `src/modules/registry/core/server.ts`

---

## Slices

### Slice 30-A: SDK Completion and `ModuleContext` Wiring — **COMPLETE**

Completed May 2026. Summary of what was done:

- `src/shared/sdk/` fully rewritten: `interfaces.ts`, `base.ts`, `context.ts`, `contracts.ts`, `server.ts`, `ui.ts`, `utils.ts`, `index.ts`
- `BaseSystemAdapter` is now a concrete class (not abstract), `systemId = 'generic'`, provides all method defaults
- `ModuleContext` wiring done in `src/server/core/system/SystemService.ts` bootstrap sequence
- `createModuleContext(moduleId)` factory in `src/server/shared/utils/createModuleContext.ts` — namespaced logger, scoped persistent cache, scoped compendium discovery
- `createModuleFoundryClient(client)` in `src/server/shared/utils/createModuleFoundryClient.ts` — wraps `RouteFoundryClient` with the stable `ModuleFoundryClient` surface; `dispatchDocument` is internal only
- `ModuleFoundryClient` expanded: full actor CRUD, item CRUD, active effect CRUD (`createActorEffect`, `updateActorEffect`, `deleteActorEffect`, `updateItemEffect`, `deleteItemEffect`), `getWorldItems`, `drawTable`, `getSystemId`
- `ModuleServerRequest`, `ModuleServerParams`, `ModuleServerExport`, `ModuleRouteHandler` added to SDK (`src/shared/sdk/server.ts`)
- `UserSession` added to SDK (already was in contracts.ts)
- `@sheet-delver/sdk` alias wired into `src/scripts/start-server.ts` generator (persists across restarts) and `next.config.ts` turbopack config
- SDK integrity test: `src/tests/unit/sdk/sdk-integrity.test.ts` — 8 test areas, all passing

**Generic module dissolved:** `src/modules/generic/` was deleted. `GenericSheet` and `GenericActorPage` moved to `src/client/ui/` as platform-owned fallback components. `FallbackAdapter extends BaseSystemAdapter` now lives inline in the registry as the no-match fallback. Eliminates the false impression that "generic" was a real external module.

---

### Slice 30-B: UI Module Surface — **Superseded by SDKProvider**

Platform-provided components (`LoadingModal`, `RollDialog`, `ConfirmationModal`, `RichTextEditor`, `SharedContentModal`) are now injected via `SDKProvider` → `SDKComponentsContext`. Modules access them through `useSDKComponents()` from `@sheet-delver/sdk` rather than direct `@client/ui/components/` imports. `SDKProvider` wraps every dynamically-loaded module component — it is placed above the module render boundary in both `ActorPageRouter` and `SheetRouter`.

The `src/client/ui/module-surface/` re-export surface is no longer necessary. The `SDKComponentsContext` in `src/shared/sdk/react.ts` is the stable contract. Module migration should replace all `@client/ui/components/` imports with `useSDKComponents()` calls.

---

### Slice 30-C: Cross-Module Isolation Fixes — **In Progress**

**dnd5e (reference migration): COMPLETE.** Compiled Mode B artifacts (`dist/logic.js`, `dist/ui.js`) are present in `<DATA_DIR>/modules/dnd5e/`. Module marked `"experimental": true` in `info.json`. Sheet UI is functional but not yet feature-complete.

**morkborg:** Imports `@modules/generic/src/logic/adapter` which was deleted — module is broken. Needs `BaseSystemAdapter` from SDK. Also imports shadowdark internals. Will follow once migration approach is confirmed from dnd5e review.

**shadowdark:** 47+ internal alias imports (`@shared/utils/logger`, `@core/*`, `@server/*`). Largest migration surface. Will follow morkborg.

---

### Slice 30-D: Build Contract Documentation — **COMPLETE**

Completed May 2026:
- `src/modules/MODULE_MANIFEST.md` fully rewritten — documents Mode A (source) and Mode B (artifact), full SDK import surface, all `ModuleFoundryClient` methods, discovery pack timing, utility functions, `tsup.config.ts` reference
- Mode detection already works in registry loader (`.ts` vs `.js` suffix)
- `@sheet-delver/sdk` as external in tsup config documented

---

## Consequences

**Positive:**
- SDK surface is honest about what it provides — no phantom types
- Modules can be migrated to SDK incrementally (alias-by-alias)
- The Mode A / Mode B distinction preserves today's development ergonomics while defining a path to production bundles
- `ModuleContext` injection eliminates the largest class of internal coupling (`@core/*`, `@shared/utils/logger`)

**Negative:**
- The UI component surface (Track 2) requires discipline to not drift. Any breaking change to `LoadingModal` props, for example, now requires coordinating with external modules.
- Mode A modules have an implicit dependency on the core's `tsx` runtime and tsconfig paths. This is a runtime coupling, not a compile-time one — it will not be caught by TypeScript alone.
- Cross-module isolation fixes (Track 3, Slice 30-C) require changes inside `data/modules/` — external module source trees. These must be done in the external repos before this ADR is fully realized.

---

## Implementation Outcome

**May 2026 — SDK phase complete. dnd5e reference migration complete.**

Slices 30-A and 30-D are done. The SDK is the authoritative import surface: `@sheet-delver/sdk` resolves correctly in both the server (`tsx` + tsconfig paths) and the Next.js client (turbopack alias). `ModuleContext` injection works end-to-end. The generic module is dissolved. The manifest document is correct and complete.

Slice 30-B is superseded: `SDKProvider` / `SDKComponentsContext` (`src/shared/sdk/react.ts`) is the stable component injection mechanism. Modules call `useSDKComponents()` to access platform UI components (`LoadingModal`, `RollDialog`, etc.) — no separate re-export surface needed. The `src/client/ui/module-surface/` path is not required.

The runtime fallback path (not covered in the original ADR) is now a first-class capability: `getUIModule()` falls back to `GET /api/modules/:id/ui` for modules installed after the current build. The server rewrites bare imports to `window.__SD.*` globals (set by `SDKGlobalProvider`) so the browser can execute Mode B artifacts via native ESM without a rebuild or an import map. This makes true hot-installation of modules possible at runtime.

**Still open:**
- morkborg migration — broken (imports deleted generic adapter), will follow dnd5e pattern
- shadowdark migration — largest surface (47+ internal imports), will follow morkborg
