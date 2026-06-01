# ADR-0027: Module SDK Standardization

**Status:** Proposed — Not implemented.
**Date:** May 31, 2026
**Phase:** SDK Standardization
**Supersedes:** None
**Revises:** ADR-0010 (external module SDK surface and migration posture)
**Related:** ADR-0011 (primary document model), ADR-0012 (primary document realtime events), ADR-0013 (ownership/visibility), ADR-0016 (document resolution and UUID routing), ADR-0017 (world bootstrap/readiness), ADR-0020 / ADR-0021 (compendium cataloging, cache-required reads), ADR-0022 (core/service/transport boundary completion), ADR-0024 (client UI state decomposition), ADR-0025 (test truthfulness), ADR-0026 (module registry post-split closeout).

---

## Context

The core/service/transport boundaries are in place (ADR-0022, ADR-0026), actor and item access is Store-backed, compendium access is declared and cache-backed (ADR-0020/0021), and the client state is decomposed into focused hooks (ADR-0024). The module SDK in `src/shared/sdk/` has not kept pace. It is still closer to a shared type/helper collection than a module authoring platform, and it has drifted from the post-boundary architecture.

Concrete evidence in the current tree:

- The only compliant local module, `data/local/modules/dnd5e`, passes `module:check` but does so by **re-implementing host behavior**. `data/local/modules/dnd5e/src/ui/ActorPage.tsx` hand-rewrites `src/client/ui/pages/GenericActorPage.tsx` (fetch, roll, update, refresh, realtime), and in doing so dropped behavior the core page has — its `handleRoll` omits the `rollMode`/`speaker` defaulting and it lacks item create/delete and shared-content handling. Hand-rolled pages drift from platform behavior.
- The other local modules import private internals because the public SDK does not expose enough. `module:check shadowdark` and `module:check morkborg` fail on import-boundary violations into `@client/*`, `@server/*`, `@modules/*`, and `@shared/*`.
- Server module routes receive a broad `ModuleFoundryClient` (`src/server/services/modules/ModuleProxyService.ts`, `src/server/shared/utils/createModuleFoundryClient.ts`). Modules also call methods that are not even in the SDK contract — `getActorRaw`, `dispatchDocument`, `dispatchDocumentSocket` — reaching onto the internal route client.
- The server-side module injection (`ModuleContext`, from `src/server/shared/utils/createModuleContext.ts`) is only handed to `adapter.initialize()`. Route handlers had no path to module-scoped persistence, and reached compendium reads a second way. There is no durable backend write surface beyond the raw `PersistentCache`.
- `SystemAdapter` still threads a `ModuleFoundryClient` through projection hooks (`normalizeActorData`, `getSystemData`, `performAutomatedSequence`) even though most do not use it.
- There is no host-owned React error boundary anywhere in `src/client`; `src/app/(player)/actors/[id]/page.tsx` catches resolve/fetch errors only, not render throws, and `data/local/modules/shadowdark/src/ui/components/ErrorBoundary.tsx` exists to compensate.
- Realtime exposed to modules is actor-only (`onActorChanged`), although `src/shared/contracts/realtime.ts`-style payloads already exist for items, combat, roll-tables, macros, playlists, and cards.
- `src/shared/sdk/ui.ts` still ships `UseFoundry`/`UseUI`/`UseNotifications`/`UseConfig` describing pre-decomposition hooks that `useSDK()` already merges.

This ADR is written from the target architecture forward, not from preserving what modules happen to do today.

### Design stance

**We conform modules to the SDK, not the SDK to the modules.** Breaking changes are expected and acceptable. That explicitly includes the currently-green `dnd5e`: it is the first re-alignment target, not a constraint to design around — we do not hold SDK shape back to keep `module:check dnd5e` passing mid-flight; we make the change and then conform `dnd5e`. `shadowdark` and `morkborg` are unmigrated and accommodated nowhere; they are migration targets. At no point do we tiptoe around an existing module's current behavior.

---

## Decision

ADR-0027 standardizes the module SDK across server, client, cross-cutting contracts, and tooling. The decisions are grouped; numbering is stable for reference.

### A. Import boundary and public entry points

1. **Strict public import boundary.** Modules import only from the public SDK and local files. Forbidden prefixes remain `@shared/*`, `@client/*`, `@server/*`, `@core/*`, `@modules/*`, `@/*`. Any private API a module legitimately needs is promoted into the SDK with a stable name, docs, and tests rather than blessed as an import.

2. **Committed subpath entry points.** The SDK exposes intentional entry points (Node package `exports` semantics): `@sheet-delver/sdk` (shared types/utils), `@sheet-delver/sdk/react` (client), `@sheet-delver/sdk/server` (server runtime types + route helpers), and `@sheet-delver/sdk/testing` (mock host). Server-only exports are rejected from UI bundles. The checker allows the `@sheet-delver/sdk` + `@sheet-delver/sdk/*` family and nothing else external. This moves as one coordinated slice with build externals, the browser import rewriter, and the global map (see K).

### B. Server runtime and mounted services

3. **Rename `ModuleContext` → `ModuleRuntime`.** The long-lived, module-scoped server injection passed to `adapter.initialize()` is renamed to disambiguate it from the client React context (`SDKContext`/`SDKContextValue`) and the per-call access context (`ModuleAccessContext`, decision 9).

4. **Flatten the `platform` wrapper.** Today `ModuleContext` nests `cache` and `compendiumPacks` under `platform` while leaving `logger` (also host-provided) flat — an inconsistent, half-applied grouping. `ModuleRuntime` flattens all surfaces onto the runtime, matching the rest of the SDK (`SDKContextValue`, server singletons, `ModuleAccessContext` are flat). If the capability set ever grows large, a single `capabilities` namespace may be introduced — grouping **all** services including `logger`, never half-applied.

5. **`ModuleRuntime` is the single server capability handle.** It is built by the platform from mounted singletons and carries:

   ```ts
   interface ModuleRuntime {
     moduleId: string;
     foundryUrl?: string;
     logger: ModuleLogger;
     // module-scoped:
     dataStore: DataStore;             // decision 12
     compendium: CompendiumPackReader; // decision 11
     // shared document services (platform wires the mounted singletons in; per-call { access }):
     documents: PrimaryDocumentStore;  // decision 6
     rolls: { roll(formula: string, label?: string, options?: RollOptions): Promise<RollResult> };
     tables: { draw(uuid: string, options?: { rollOverride?: number }): Promise<DrawResult> };
   }
   ```

   The platform instantiates the services once when the server mounts (backed by `src/server/services/*` and the stores in `src/server/core/documents/primary/*`) and wires them into `ModuleRuntime`. **Module and adapter code never import or call `getInstance()`** — that is internal wiring. The *same* `ModuleRuntime` is passed to both `adapter.initialize(runtime)` and `createApiRoutes(runtime)`, so adapter and routes share one handle.

6. **Generic, type-keyed document store.** The document surface is the shared `PrimaryDocumentStore` contract (already the base of every primary store: `get` / `list` / `patch` / `upsert` / `delete` / `seed` in `src/server/core/documents/primary/base/`), exposed as `runtime.documents`:

   ```ts
   interface PrimaryDocumentStore {
     list(type, query?, opts): Promise<{ rows, total, page }>;  // query: filter/sort/page/pageSize/limit
     get(type, id, opts): Promise<FoundryDocument | null>;
     create(type, data, opts): Promise<FoundryDocument>;
     patch(type, id, updates, opts): Promise<FoundryDocument>;
     upsert(type, data, opts): Promise<FoundryDocument>;
     delete(type, id, opts): Promise<void>;
     commit(type, ops[], opts): Promise<...>;        // batched CRUD, one round-trip
     fetchByUuid(uuid, opts): Promise<FoundryDocument | null>;
     effects: { create, update, delete };            // embedded sub-docs on actor/item
   }
   ```

   `Actor` is **not** a special surface; it was migrated into the primary stores alongside `Item`, `JournalEntry`, `Combat`, `RollTable`, `Macro`, etc. precisely so one uniform pattern serves all. Adding a store to the public surface is an allowlist decision, not new per-type API. Implemented (exposed) types: `Actor`, `Item`, `JournalEntry`, `Combat`, `RollTable`, `Macro`, `Playlist`, `Cards`, `Folder`, `User`, `ChatMessage`. Stub stores stay internal: `Scene`, `Adventure`, `Setting`, `FogExploration`. The reach-ins `getActorRaw` / `dispatchDocument` / `dispatchDocumentSocket` are eliminated and collapse into `documents.*` + `fetchByUuid`.

7. **Irreducible non-CRUD primitives only; richer behavior is module-authored.** Beyond the document store, the runtime exposes `rolls.roll` (dice evaluation, structured result, no forced chat), `tables.draw` (roll + match), and `compendium` (decision 11). `chat.send` is `documents.create('ChatMessage', …)`. Anything richer — attack sequences, level-up, combat turn control, formatted chat cards — is composed by the module author in their own routes over these primitives. The platform does not pre-bake an action for every system mechanic. `performAutomatedSequence`-style logic relocates here (decision 15).

8. **Thin request + `createApiRoutes(runtime)` factory.** The request carries only identity and body; no services are injected on it.

   ```ts
   interface ModuleServerRequest {
     method: string; url: string; headers: Headers;
     userSession?: ModuleUserSession;
     getAccessContext(): ModuleAccessContext;   // user id, role, module id, trust/permission grants
     json<T = unknown>(): Promise<T>;
     logger: ModuleLogger;
   }

   // Module code imports only types + stateless helpers — never service singletons.
   import { json, error, type ModuleRuntime, type ModuleRouteTable } from '@sheet-delver/sdk/server';
   export function createApiRoutes(runtime: ModuleRuntime): ModuleRouteTable {
     return {
       'attack': async (req) => {
         const access = req.getAccessContext();
         const actor  = await runtime.documents.get('Actor', actorId, { access, minOwnership: 'observer' });
         return json({ ok: true });
       },
     };
   }
   ```

   `createApiRoutes(runtime)` is the preferred server export; a static `apiRoutes` table remains valid only for route tables that need no runtime services. Route keys stay path-only (`attack`, `actors/[id]`); method dispatch is via `req.method` unless the router is deliberately given method-aware keys.

### C. Access, permission, and fail-closed semantics

9. **Explicit per-operation access context.** Document reads and writes take an explicit `{ access, minOwnership }` derived from the request via `req.getAccessContext()`. This makes authorization visible at the call site rather than ambient. Ownership thresholds use the Foundry-style ladder (`limited` / `observer` / `owner`).

10. **Enforcement at the service/store boundary, fail-closed.** The platform already declares a security model — `ModuleTrustDeclaration` (`trust.tier`) and `ModulePermissionDeclaration` (`network.outbound`, `filesystem`, `adminRoutes`, `sensitiveData`) — and a live policy layer (`src/modules/registry/security/permissionPolicy.ts`, `trustPolicy.ts`). The SDK exports the declarations but does not yet gate any surface on them. The document service must be wired to this policy, with scoping riding the store ownership layer (`src/server/core/documents/primary/base/ownership.ts`):
    - Reads fail closed when access is missing, the document is not visible at the requested ownership threshold, or ownership cannot be resolved.
    - Writes require both module trust/permission grants and document ownership at the required write threshold; otherwise a structured error (`permission_denied` / `out_of_scope`).
    - Unknown/ambiguous ownership blocks the operation; it is not a soft warning.
    - `commit` verifies each target operation before dispatch; no privileged internal batch path bypasses per-document checks.
    There is **no manifest document-scope gate** — documents are mutable, so the permission/ownership layer is the gate; a manifest declaration would add meaning the system does not need.

### D. Compendium and persistence

11. **Compendium declaration = hydration intent, not an access gate.** `info.json` `compendiumPacks` declares which packs are hydrated (full documents available). A pack present in `game.data.packs` but undeclared is still readable at index level (harmless — the compendium store is read-only, no CRUD). The only fail-closed rule is that a read for something **not present in `game.data.packs` or the compendium at all** does not reach into Foundry (a live fetch that cannot resolve). This preserves the passive seeding and cache-first hydration of ADR-0020/0021. The read API is `runtime.compendium` (`findOne` / `findAll` / `getById`), shared by adapter `initialize` and routes via `createApiRoutes`.

12. **`DataStore` for backend module persistence.** `PersistentCache` (`src/server/core/cache/PersistentCache.ts`) is raw and cache-connoted (`get`/`set`/`delete` only). The SDK exposes a durable, bounded `DataStore` on the runtime instead:

    ```ts
    interface DataStore { get<T>(key): Promise<T|null>; set<T>(key, value): Promise<void>; delete(key): Promise<void>; has(key): Promise<boolean>; keys(prefix?): Promise<string[]>; }
    ```

    Module-owned local data only (preferences, generated indexes, cached computations); no Foundry reach, not compendium reads, not secrets. Keys are flat logical names validated against path separators and reserved names. `PersistentCache` becomes internal backing; modules never import it. This is the server-side durable counterpart to the client `useModuleSettings` (decision 19).

13. **Storage boundary under the module cache dir.** Today both module data (`cache.get(moduleId, key)`) and compendium backing (`CompendiumStore` writing `manifestKeyFor`/`shardKeyFor` under namespace = systemId, `src/server/core/compendium/CompendiumStore.ts`) land flat in `<DATA_DIR>/cache/<moduleId>/`. Split them: `<DATA_DIR>/cache/<moduleId>/datastore/<key>.json` for `DataStore`, `<DATA_DIR>/cache/<moduleId>/compendiums/` for compendium backing — so `DataStore.keys()` never returns pack shards or platform metadata. This is required for `keys()` to be correct; implement it when wiring `DataStore`. Compendium shards re-hydrate from `game.data`, so migration cost is low.

### E. Adapter purity and hook relocation

14. **Pure projection adapter; drop the `client` parameter.** Projection hooks do not receive a `ModuleFoundryClient`. Keep the actual signatures:

    ```ts
    interface SystemAdapter {
      systemId: string;
      match(actor: FoundryActor): boolean;
      normalizeActorData(actor: FoundryActor): ActorSheetData;      // drop client param
      initialize?(runtime: ModuleRuntime): Promise<void>;
      dispose?(runtime: ModuleRuntime): Promise<void>;              // decision 22
      categorizeItems?(actor: ActorSheetData): Record<string, FoundryItem[]>;
      getActorCardData?(actor: FoundryActor): ActorCardData;
      getRollData?(actor: FoundryActor, type: string, key: string, options?: RollDataOptions): RollData | null;
      getInitiativeFormula?(actor: FoundryActor): string;
      validateUpdate?(path: string, value: unknown): boolean;
    }
    ```

15. **Relocate the two client-coupled flows.**
    - `getSystemData` stays a core route (`/system/data`, served via `registerSystemRoutes.ts`); it is data the adapter *produces*, not something modules consume. Its hook sources from `runtime.compendium` + `runtime.documents` instead of a live client. Module registry-style system-data caches collapse into `runtime.compendium` + `runtime.dataStore`.
    - `performAutomatedSequence` is **not** an adapter hook. System rules stay in module code as a module-authored route; the reusable primitives it leans on become SDK artifacts: a structured no-chat `rolls.roll`, a server-side `parseRollResult` helper (the counterpart to the existing client-side `simulateRoll`/`simulateTableDraw` in `src/shared/sdk/utils.ts`), and a chat-card render contract plus `componentStyles.chat`.
    - `resolveActorNames` is removed once compendium data flows through `runtime.compendium`.

### F. Client sheet SDK and surface hosting

16. **Client sheet SDK.** Expose stable sheet props and a controller hook so modules write presentation, not page mechanics:

    ```ts
    interface ActorSheetProps<TActor = FoundryActor> { actor: TActor; isOwner: boolean; foundryUrl?: string; onRoll; onUpdate; refreshActor?; }
    function useActorSheet(actorId, options?): { actor; loading; notFound; isOwner; foundryUrl?; refresh; roll; update };  // actor-focused only
    function createActorPage(Sheet: ComponentType<ActorSheetProps>): ComponentType<ActorPageProps>;
    ```

    `actorPage` is **optional**: the default is a platform-hosted sheet. A module ships a presentational `Sheet` over `ActorSheetProps`; `createActorPage(Sheet)` or a custom `actorPage` is the escape hatch for a bespoke shell. This deletes the `GenericActorPage` duplication in `dnd5e`.

17. **Item/effect mutation lives on document hooks, off the sheet hook.** `useActorSheet` stays actor-focused (load/roll/update/refresh). Item and effect CRUD use lower-level client document hooks that mirror the server store:

    ```ts
    const doc = SDK.Client.useDocument(type, id);            // read + subscribe
    const m   = SDK.Client.useDocumentMutation(type);        // create/patch/delete + effects
    ```

18. **`SurfaceHost`: one host-owned boundary for every dynamic module surface.** There is no React error boundary in `src/client` today. Add a host-owned error + loading boundary that wraps every dynamically loaded module surface — actor page, `tools` (`src/client/ui/pages/ToolPageRouter.tsx`), `dashboardTools` (`src/client/ui/components/SystemTools.tsx`), and `rollModal` (`src/client/ui/components/Combat/CombatHUD.tsx`). The actor sheet is not the only authoring surface; all of them get the same context injection + boundary + style-scope root.

19. **Host-provided runtime identity.** `SurfaceHost`/`SDKProvider` supplies `moduleId`, `worldId`, and `system` into `SDKContextValue`; client hooks consume that rather than discovering identity via `/system/data`. `StatusService` already emits `worldId` (observed by `useSystemStatusRealtime`); lift it into the provider. `moduleId` is known at each surface resolution point.

### G. Realtime / event signal bus

20. **Expand realtime to all document types via a signal bus.** Replace the actor-only `onActorChanged` with `SDK.events.on(signal, handler)`. Formalize an initial signal set from the existing realtime contracts and expand as needed:
    - `world:ready` | `world:teardown` | `connection:changed`
    - `module:initialized` | `module:disposed`
    - `document:changed {type,id,action}` | `document:listInvalidated {type,reason}`
    - `content:shared {kind,data}`
    Combat turn/round changes are **not** a separate signal — a `Combat` is a primary
    document, so they ride `document:changed {type: 'Combat'}` like every other document
    (no per-type special-casing). A dedicated turn-semantics signal is a later, justified
    extension only if real module usage needs old/new-turn detail beyond a document refresh.
    Subscriptions are host-owned and follow React external-store expectations; modules do not subscribe to raw sockets.

### H. Settings, capabilities, errors, query

21. **Module settings.** `useModuleSettings()` (`get`/`set`) persists to `localStorage` from a schema declared in `info.json` `settings`, namespaced by host-provided `worldId + moduleId`. It does not query `/system/data` and replaces ad-hoc localStorage (e.g. the `useSheetSetting` pattern in `dnd5e`). This is the client counterpart to `DataStore` (decision 12).

22. **Lifecycle: single-active + courtesy teardown.** Exactly one system/world module is active at a time and state does not change mid-operation; a world state transition (return-to-setup / shutdown, ADR-0017) tears the module down wholesale. `adapter.dispose?(runtime)` is an optional courtesy for state-saving, not a per-operation resource contract.

23. **Capability detection.** `SDK.capabilities.supports('combat' | 'effects' | 'tables' | …): boolean` for optional surfaces, paired with the existing `SDK_VERSION` / `API_CONTRACT_VERSIONS`.

24. **Structured error taxonomy + response helpers.** Complete the existing `{ error: string; status: number }` payload (`src/server/shared/utils/isErrorPayload.ts`) with a stable code:

    ```ts
    type SdkError = { code: SdkErrorCode; message: string; status: number };
    type SdkErrorCode = 'not_found' | 'permission_denied' | 'out_of_scope' | 'not_ready' | 'validation' | 'conflict' | 'internal';
    ```

    Routes return responses via SDK `json(data, init?)` / `error(code, message, status?)` helpers (the latter emits the `SdkError` shape) — never hand-built `Response`. `out_of_scope` is the fail-closed signal (decisions 10/11); `not_ready` is the readiness signal (decision 25).

25. **Readiness blocks; query/cache hidden behind hooks.** Server-service calls block until the world is ready (ADR-0017); they do not proceed against an unready world. `not_ready` surfaces only if readiness cannot be reached. On the client, hooks are the only module-facing data API, backed by a small host-owned cache (internal — build-vs-library is an implementation choice; no query library is exposed to modules). The cache **dedups concurrent reads of the same document across surfaces, keyed by document type + id**: e.g. a dashboard actor card and an open actor sheet (and any tool/combat surface) reading the same actor resolve to **one** fetch, not one per surface — replacing the per-page in-flight dedup + debounce that `src/client/ui/pages/GenericActorPage.tsx` hand-rolls today. A realtime `document:changed` invalidates the cache key and every mounted surface refreshes from the single source; the module just calls the hook and never re-fetches per surface.

### I. Universal document DTO

26. **`FoundryDocument` is a frozen, versioned envelope with an opaque `system` bag.** The envelope (`_id`, `name`, `type`, `img`, `ownership`, `flags`, `_stats`) is the stable contract; `system` varies by system and is never typed at the SDK boundary. `ActorSheetData` adds `items`, `effects`, and a module-computed `derived` region. Internal store refactors cannot break the envelope; `system` shape stays the adapter's concern.

### J. Assets and styles

27. **`assetUrl()` is the single asset mechanism, served identically in dev and packaged.** Runtime assets and the declared `stylesheet` are referenced via `assetUrl()` → `/api/modules/<id>/assets/<path>`, never bundler/TSX imports. The asset route (`src/server/routes/modules/createModuleRouter.ts`) currently serves only installed modules from `<DATA_DIR>/modules`; extend it to serve local-dev modules (`getLocalModulesDataDir()`) so the same URL resolves in dev and packaged. Module JS/TSX continues to bundle through webpack in dev (via the `@local-modules` alias) and esbuild at package time; CSS and static assets move off webpack onto the URL route.

28. **Style isolation is runtime-only.** `SurfaceHost` renders each surface inside a host-generated root (`.sdk-module--<id>` + `data-theme`); the platform's Tailwind utility layer stays global and shared; the module's own CSS is scoped under that root (its `:root` vars become root-class vars), enforced by a `module:check` lint. There is **no** build-time CSS rewrite — a package-time-only transform would break dev/packaged parity. Shadow DOM is rejected because it would sever the shared Tailwind layer.

### K. Tooling conformance

29. **Checker, packager, `next.config.ts`, and `init-module` conform to the SDK — not preserved as-is.** `src/scripts/tools/modules/check-module.ts` and `package-module.ts` duplicate build config inline; extract a single shared build-config module so validation cannot drift from packaging. Both must:
    - externalize the SDK subpaths and React as wildcards (`@sheet-delver/sdk`, `@sheet-delver/sdk/*`, `react`, `react/*`, `react-dom`, `react-dom/*`);
    - recognize the `createApiRoutes` export (and named re-exports), in addition to `apiRoutes` / `export { apiRoutes }`; continue rejecting `export *`;
    - drop reliance on TSX asset imports (no `file`/`dataurl` loader) in favor of `assetUrl()`;
    - gate packaging on `module:check` — a non-conforming module is not packageable.
    `next.config.ts` currently aliases only the exact `@sheet-delver/sdk` (turbopack + webpack blocks); add `@sheet-delver/sdk/react|server|testing` prefix aliases, and the browser import rewriter / global map in `createModuleRouter.ts` (`GLOBAL_MAP`) must expose the subpath globals (server-only rejected from UI). `init-module` generates no per-module webpack/next config — only `tsconfig.json`, `info.json`, a starter stylesheet, and templates — so there is nothing generated to migrate; its templates should model `assetUrl()` and `createApiRoutes`, and avoid bundler asset imports.

30. **Contract tests and testing utilities.** `@sheet-delver/sdk/testing` provides a mock host (mock `ModuleRuntime`, the wired services, and SDK providers). Per ADR-0025, SDK changes need contract tests, not just type exports: a fixture module using only public SDK APIs must render a sheet, fetch/mutate through the runtime, send a roll, process a realtime change, resolve a declared compendium document, persist via `DataStore`, and resolve a packaged asset URL. Removed compatibility surfaces get no module-facing deprecation window; any staging bridge is internal-only per decision 31 and absent from the fixture surface.

### L. Removal (no compatibility window)

31. **`ModuleFoundryClient` and the broad client surface are removed — not deprecated.** Consistent with the design stance (conform modules to the SDK, not the reverse), the broad client is removed from the module surface **as part of the server SDK change in Phase 1**, not kept as a deprecated-but-available shim. It is not on the request, not passed to adapter hooks, and not a supported module API. Removal is gated on the SDK landing, **not** on module migration — the SDK does not wait for the modules. Modules break and are conformed per their phase (`dnd5e` Phase 3, `morkborg` Phase 6, `shadowdark` Phase 7); `module:check dnd5e` is allowed to fail between Phase 1 and Phase 3 by design. If staging the work across commits needs a temporary bridge, it is **internal only** (core wiring, never exported, never module-facing) and deleted within the SDK work — it is not a module deprecation surface. Adapter `client` parameters and `resolveActorNames` are removed in the same breaking change (decision 14), which requires relocating `getSystemData` and `performAutomatedSequence` first (decision 15). Internal transports and stores — `CoreSocket`, `ClientSocket`, route clients, registry satellites, compendium stores — are never exposed through SDK shims (ADR-0022, ADR-0026).

---

## Consequences

**Positive**

- Modules write system-specific projection and presentation; the platform owns document access, identity, realtime, modals, page hosting, persistence, and asset serving.
- One server capability handle (`ModuleRuntime`) for adapter and routes; no per-request service injection; no module-facing `getInstance()`.
- Least-privilege is enforced and visible (`{ access }` at every call), backed by the existing trust/permission policy.
- The `dnd5e` page-shell duplication is deleted; behavior drift between modules and the platform is structurally prevented.
- Build and release tooling cannot drift from validation (shared config), and dev/packaged behavior is identical for assets/CSS.

**Negative / risks**

- This is a breaking SDK revision. `dnd5e` will break during the work and must be conformed; `morkborg` and `shadowdark` require rewrites.
- The subpath entry-point slice (B/K) is coordinated across externals, checker, browser rewriter, and `next.config.ts`; partial application breaks dev or packaged loads.
- The `DataStore` storage-boundary split (D) is a one-time on-disk layout change; compendium backing re-hydrates, but the migration must run before `keys()` is relied upon.
- Readiness-blocking semantics (decision 25) must not let a module wake or restart the Foundry transport through timing (ADR-0017/0021).

---

## Implementation Plan

Phases are sequenced so each slice is independently verifiable. Checkpoints are markable as work lands. A phase is "done" only when its checkpoints and the relevant Verification items pass. This ADR intentionally reorders the audit's recommended migration plan: the server runtime lands before the client sheet SDK so removed module-facing clients cannot leak into the new public surface.

### Phase 0 — Baseline and policy

- [x] Record current `module:check dnd5e` as a baseline, explicitly not a contract to preserve.
- [x] Extract a shared build-config module consumed by `check-module.ts` and `package-module.ts` (decision 29). — `src/scripts/tools/modules/build-config.ts`; both tools consume it.
- [ ] Document the SDK boundary policy: public entry points only; no module-facing compatibility shims or deprecation windows — breaking changes land and modules conform (decisions 1, 2, 31).
- [ ] Fix stale server-route docs (`docs/MODULE_AUTHORING.md`) to current `ModuleRouteHandler` + `json()`/`error()` usage.

### Phase 1 — Server runtime, services, access, persistence

- [x] Rename `ModuleContext` → `ModuleRuntime`; flatten the `platform` wrapper; update `createModuleContext.ts` and the `sdk-integrity.test.ts` assertions (decisions 3, 4). — files also renamed `runtime.ts` / `createModuleRuntime.ts`; verified green (unit suite + `module:check dnd5e`).
- [ ] Mount document/roll/table services as singletons and wire them onto `ModuleRuntime` (`documents`, `rolls`, `tables`); module code never calls `getInstance()` (decision 5).
- [ ] Implement the generic type-keyed `PrimaryDocumentStore` surface incl. `commit`, `fetchByUuid`, `effects`, and list query (filter/sort/page/limit) (decision 6).
- [ ] Add `ModuleServerRequest.getAccessContext()` and the `createApiRoutes(runtime)` factory export contract (decision 8).
- [ ] Wire permission/trust + ownership enforcement; reads/writes fail closed; `commit` verifies per-op (decisions 9, 10).
- [~] Add `DataStore` on the runtime and the `datastore/` vs `compendiums/` storage boundary; make `PersistentCache` internal (decisions 12, 13). — `DataStore` (`get/set/delete/has/keys`) on `ModuleRuntime`, backed under `<moduleId>/datastore/`; `PersistentCache` no longer SDK-exported. Remaining: relocate compendium backing to `compendiums/` (DataStore is already isolated, so not blocking).
- [ ] Make service calls readiness-aware (block until ready; `not_ready` on unreachable) (decision 25).
- [ ] Eliminate `getActorRaw` / `dispatchDocument` / `dispatchDocumentSocket` reach-ins (decision 6).
- [ ] Add `SdkError` taxonomy + `json()`/`error()` response helpers (decision 24).
- [ ] Relocate `getSystemData` (source from `runtime`) and `performAutomatedSequence` (module-authored route); then **remove** `ModuleFoundryClient` from the module surface, the adapter `client` parameters, and `resolveActorNames` — breaking, no module-facing shim; `dnd5e` is conformed in Phase 3 (decisions 14, 15, 31).

### Phase 2 — Client sheet SDK and surface hosting

- [ ] Export `ActorSheetProps`, `useActorSheet` (actor-focused), and `createActorPage`; make `actorPage` optional with a default platform host (decision 16).
- [ ] Add `useDocument` / `useDocumentMutation` client hooks; remove item/effect CRUD from `useActorSheet` (decision 17).
- [ ] Add `SurfaceHost` (host-owned error + loading boundary + style-scope root) and wrap every dynamic surface: actor page, `tools`, `dashboardTools`, `rollModal` (decision 18).
- [ ] Provide host-supplied runtime identity (`moduleId`, `worldId`, `system`) via the provider; stop `/system/data` identity discovery (decision 19).
- [ ] Back data hooks with a host-owned cache (dedup + realtime invalidation); expose no query library (decision 25).

### Phase 3 — Prove it with dnd5e (conform)

- [ ] Migrate `dnd5e` to `ModuleRuntime`, `createApiRoutes`, the client sheet SDK, and document hooks; expect breakage and conform it (design stance).
- [ ] Remove the hand-rolled page-shell duplication; keep the visual sheet module-owned; restore the dropped `rollMode`/`speaker`/item/shared-content behavior via the platform host.
- [ ] Leave the `dnd5e` adapter as the canonical pure-projection example; keep `module:check dnd5e` green from here on.

### Phase 4 — Compendium, assets, styles, settings, capabilities, events

- [ ] Implement `runtime.compendium` hydration-intent semantics + fail-closed unknown reads (decision 11).
- [ ] Implement `assetUrl()` and extend the asset route to serve local-dev modules; drop TSX asset imports (decision 27).
- [ ] Implement runtime CSS scoping under the `SurfaceHost` root + the `module:check` global-leak lint (decision 28).
- [ ] Implement `useModuleSettings` + `info.json` `settings` schema (decision 21).
- [ ] Implement `SDK.capabilities.supports(...)` (decision 23).
- [ ] Implement the realtime/event signal bus across all document types; retire actor-only `onActorChanged` (decision 20).
- [ ] Add `adapter.dispose?(runtime)` courtesy teardown on world state transition (decision 22).
- [ ] Add `parseRollResult` and the chat-card render contract (decision 15).

### Phase 5 — Tooling conformance

- [ ] Subpath entry points + package `exports`; checker allows only the SDK family (decisions 2, 29).
- [ ] Wildcard externals for SDK subpaths + React in checker and packager (decision 29).
- [ ] Checker recognizes `createApiRoutes`; packaging gated on `module:check`; drop asset loaders (decision 29).
- [ ] `next.config.ts` subpath aliases + browser rewriter/global map subpath globals (server-only rejected from UI) (decision 29).
- [ ] Update `init-module` templates to model `assetUrl()` + `createApiRoutes` (decision 29).
- [ ] Ship `@sheet-delver/sdk/testing` mock host + the contract-test suite (decision 30).

### Phase 6 — Migrate Mörk Borg

- [ ] Replace the removed generic adapter with `BaseSystemAdapter`.
- [ ] Export `createApiRoutes` (or `apiRoutes` if runtime-free); move server ops to runtime services + access options.
- [ ] Move image handling to `assetUrl()`; remove TSX image imports.
- [ ] Replace private UI imports with `useSDK`, `useSDKComponents`, `useActorSheet`, and document hooks.
- [ ] `module:check morkborg` passes.

### Phase 7 — Migrate Shadowdark

- [ ] Fix manifest UI entry, syntax errors, duplicate exports, and the `export *` server shape first.
- [ ] Replace the cache-scanning registry with `runtime.compendium` + `runtime.dataStore`.
- [ ] Replace internal compendium/document/socket access with runtime services; replace private UI contexts/components with SDK hooks.
- [ ] `module:check shadowdark` passes.

### Phase 8 — Boundary closeout (confirmation)

The breaking removals already happened in Phase 1; this phase confirms nothing crept back.

- [ ] Confirm no module-facing `ModuleFoundryClient`, adapter `client` parameters, or `resolveActorNames` remain (removed in Phase 1).
- [ ] Confirm only intentional public exports across the committed entry points (decision 31).
- [ ] Delete any internal staging bridge used during sequencing; confirm none is reachable from module code.

---

## Verification

The SDK is considered standardized when all of the following hold:

- [ ] A new system module renders an actor sheet without importing `@client/*`, `@server/*`, `@core/*`, `@modules/*`, or `@shared/*` — only `@sheet-delver/sdk` and its subpaths.
- [ ] A module can choose a platform-hosted sheet or a custom actor page using public SDK hooks only.
- [ ] A module route reads/writes documents, rolls, and UUID lookups through `runtime` services with explicit per-operation `{ access }`; no `getInstance()` in module code, no services on the request.
- [ ] Document reads/writes fail closed on missing/insufficient access; `commit` verifies per-op; unknown/ambiguous ownership blocks.
- [ ] Adapter projection hooks are deterministic and take no request-scoped client.
- [ ] Compendium reads come through `runtime.compendium` (declaration = hydration intent); the truly unknown is never live-fetched.
- [ ] A module persists server-side data through `runtime.dataStore` without importing `PersistentCache`, and `keys()` never returns compendium backing.
- [ ] Module routes return responses via `json()` / `error()`; errors carry stable `SdkError` codes.
- [ ] Module UI bundles use the host React runtime (no second copy) and load assets/CSS by URL identically in dev and packaged.
- [ ] Every dynamic module surface is wrapped by `SurfaceHost` (error + loading boundary + style-scope root).
- [ ] Client hooks derive identity from host-provided `moduleId`/`worldId`/`system`, never `/system/data`.
- [ ] SDK contract tests prove render, runtime service access, realtime refresh, compendium read, `DataStore` persistence, and asset resolution using public APIs only.
- [ ] `dnd5e`, `morkborg`, and `shadowdark` all pass `npm run module:check`.

---

## Verification status

- [ ] Phases 0–8 checkpoints complete.
- [ ] Verification criteria satisfied.
- [ ] Contract test suite green in CI.
