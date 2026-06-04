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
- The server-side module injection has started moving from `ModuleContext` to `ModuleRuntime` (`src/server/shared/utils/createModuleRuntime.ts`, `src/shared/sdk/runtime.ts`) and now carries `DataStore` + `compendium`, but it is still only handed to `adapter.initialize()`. Route handlers still lack the user-bound `req.runtime` surface for document/roll/table operations, and the old route contract still exposes `foundryClient`.
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

4. **Flatten the `platform` wrapper.** The old `ModuleContext` nested `cache` and `compendiumPacks` under `platform` while leaving `logger` (also host-provided) flat — an inconsistent, half-applied grouping. `ModuleRuntime` flattens all surfaces onto the runtime, matching the rest of the SDK (`SDKContextValue`, server singletons, `ModuleAccessContext` are flat). If the capability set ever grows large, a single `capabilities` namespace may be introduced — grouping **all** services including `logger`, never half-applied.

5. **Singleton services; `ModuleRuntime` is the per-request handle over them.** The platform mounts the document/roll/table services + stores **once** at server start. What a module receives is a thin `ModuleRuntime` handle that forwards to those singletons — the services are never re-instantiated per request and module code never calls `getInstance()` (internal wiring). The runtime comes in **two flavors**:

   ```ts
   // Read-only base — passed to adapter.initialize(runtime). Module-scoped, memoizable.
   interface ModuleRuntime {
     moduleId: string;
     foundryUrl: string;
     logger: ModuleLogger;
     dataStore: DataStore;                 // decision 12 (module's own sandbox)
     compendium: CompendiumPackReader;     // decision 11 (read)
     documents: ReadonlyDocumentStore;     // decision 6 — get/list/fetchByUuid ONLY (no CRUD)
   }

   // Request runtime — `req.runtime` on a route handler. Base + user-bound writes + primitives.
   interface ModuleRequestRuntime extends ModuleRuntime {
     documents: DocumentStore;             // read + create/patch/upsert/delete/commit/effects
     rolls: { roll(formula, label?, options?): Promise<RollResult> };
     tables: { draw(uuid, options?): Promise<DrawResult> };
   }
   ```

   Why per-request: writes go through the **acting user's** Foundry socket (`FoundryUserConnectionService` holds one `ClientSocket` per session), so a document op must act as a specific user. The runtime handle is per-request and **defaults its acting identity to `req.userSession`** (decision 9); the heavy services beneath are singletons, so per-request cost is just binding the default subject + a few closures (the base runtime is memoized per module). **Core resolves the user's transport from identity internally — the socket never crosses the SDK boundary.** This deliberately rejects (a) a per-request *factory* (`createApiRoutes(runtime)` per call — overcomplication) and (b) `AsyncLocalStorage`/ambient context — ambient would be a foreign pattern in a system that elsewhere reasons about visibility by **explicit subject** (`createAccessSubject`, ownership levels), and making it consistent would force a system-wide retrofit. The runtime-on-request keeps the platform's explicit-subject model intact.

6. **Generic, type-keyed document store.** The document surface is the shared `PrimaryDocumentStore` contract (already the base of every primary store: `get` / `list` / `patch` / `upsert` / `delete` / `seed` in `src/server/core/documents/primary/base/`), exposed as `runtime.documents`:

   ```ts
   // Reads — also the adapter's entire document surface (read-only, decision 14).
   interface ReadonlyDocumentStore {
     list(type, query?, opts?): Promise<{ rows, total, page }>;  // query: filter/sort/page/pageSize/limit
     get(type, id, opts?): Promise<FoundryDocument | null>;
     fetchByUuid(uuid, opts?): Promise<FoundryDocument | null>;
   }
   // Writes — only on the per-request `req.runtime` (decision 5), never the adapter.
   interface DocumentStore extends ReadonlyDocumentStore {
     create(type, data, opts?): Promise<FoundryDocument>;
     patch(type, id, updates, opts?): Promise<FoundryDocument>;
     upsert(type, data, opts?): Promise<FoundryDocument>;
     delete(type, id, opts?): Promise<void>;
     commit(type, ops[], opts?): Promise<...>;       // batched CRUD, one round-trip
     effects: { create, update, delete };            // embedded ActiveEffect on a parent
     items:   { create, update, delete };            // embedded Item on an actor parent (Phase 6 addendum)
   }
   // On req.runtime, opts carries the optional access override (decision 9);
   // default is the calling user. Base-runtime reads are platform/system scoped
   // and fail closed when a user-scoped access decision is required.
   ```

   **Addendum (Phase 6).** A parent-scoped embedded `items` surface was added next to `effects` so a module's *server* route can create/update/delete an actor's owned Items via `req.runtime.documents.items` — the server counterpart to the client `useDocumentMutation().embedded`. Each op is parent-ownership gated like `effects` (WRITEABLE on the parent). Surfaced by conforming `morkborg`, whose server sequences create/delete actor items; without it the server runtime could only mutate ActiveEffects.

   `Actor` is **not** a special surface; it was migrated into the primary stores alongside `Item`, `JournalEntry`, `Combat`, `RollTable`, `Macro`, etc. precisely so one uniform pattern serves all. Adding a store to the public surface is an allowlist decision, not new per-type API. Implemented (exposed) types: `Actor`, `Item`, `JournalEntry`, `Combat`, `RollTable`, `Macro`, `Playlist`, `Cards`, `Folder`, `User`, `ChatMessage`. Stub stores stay internal: `Scene`, `Adventure`, `Setting`, `FogExploration`. The reach-ins `getActorRaw` / `dispatchDocument` / `dispatchDocumentSocket` are eliminated and collapse into `documents.*` + `fetchByUuid`.

7. **Irreducible non-CRUD primitives only; richer behavior is module-authored.** Beyond the document store, the request runtime exposes `rolls.roll` (dice evaluation, structured result, no forced chat) and `tables.draw` (roll + match); `compendium` is available on both the base runtime and `req.runtime` (decision 11). `chat.send` is `documents.create('ChatMessage', …)`. Anything richer — attack sequences, level-up, combat turn control, formatted chat cards — is composed by the module author in their own routes over these primitives. The platform does not pre-bake an action for every system mechanic. `performAutomatedSequence`-style logic relocates here (decision 15).

   **Addendum (Phase 6).** Promoted `chat` to a first-class `req.runtime.chat` surface: `chat.send(message)` (post a raw ChatMessage — the module builds the body), `chat.card(card, options?)` (post the structured `ChatCard` render contract of decision 15 — the reusable "create a chat card" primitive; the rendered body goes to `content` and the full card rides a `flags.sheetDelver.chatCard` flag for a client renderer), and `chat.useItem(actorId, itemId)` (the default "uses item" card for an actor's item). `useItem` had no SDK equivalent during the `morkborg` conformance and several systems post a card on item-use / actions, so these are reusable primitives rather than per-module reimplementations. All three are user-bound and readiness-gated like the other request services.

8. **Static `apiRoutes`; the runtime arrives on the request (`req.runtime`).** No per-request factory. A module exports a static handler table once; the platform attaches the per-request runtime to the request before invoking the handler.

   ```ts
   interface ModuleServerRequest {
     method: string; url: string; headers: Headers;
     json<T = unknown>(): Promise<T>;
     userSession?: ModuleUserSession;          // identity
     runtime: ModuleRequestRuntime;            // per-request handle, defaulted to userSession
     getAccessContext(): ModuleAccessContext;  // read the caller's access / build an override
   }

   // Module code imports only types + stateless helpers — never service singletons.
   import { json, error, type ModuleRouteTable } from '@sheet-delver/sdk/server';
   export const apiRoutes: ModuleRouteTable = {
     'attack': async (req) => {
       // defaults to the calling user (req.userSession):
       const actor = await req.runtime.documents.get('Actor', actorId);
       await req.runtime.documents.patch('Actor', actorId, updates);
       return json({ ok: true });
       // non-norm override: req.runtime.documents.patch('Actor', id, updates, { access });
     },
   };
   ```

   Dispatch flow in `ModuleProxyService`, per request: `userSession` (already resolved by auth middleware) → `req.runtime = base(moduleId) + user-bound { documents, rolls, tables }` → invoke `handler(req, params)`. `base(moduleId)` is memoized per module. Route keys stay path-only (`attack`, `actors/[id]`); method dispatch is via `req.method` unless the router is deliberately given method-aware keys. There is no `foundryClient` on the request.

### C. Access, permission, and fail-closed semantics

9. **Default to the calling user; explicit `{ access }` only for the non-norm case.** Document ops on `req.runtime` default their acting identity to `req.userSession` — so `req.runtime.documents.patch('Actor', id, updates)` acts as the caller with **no ceremony**. A module passes `{ access }` (and optional `minOwnership`) **only** to act as a different subject (e.g. system context) — the deliberate, visible escape hatch. Ownership thresholds use the Foundry-style ladder (`limited` / `observer` / `owner`); `getAccessContext()` reads the caller's access or builds an override.

   This is **explicit-with-default**, not ambient. `AsyncLocalStorage`/ambient was considered and rejected: the platform reasons about visibility by **explicit subject** everywhere else (`createAccessSubject`, ownership maps, `DOCUMENT_VISIBILITY`), so ambient would be either an inconsistent island or a system-wide retrofit. The default-from-`userSession` keeps call sites clean for the common case while staying within the explicit-subject model; the acting subject is always a real subject, never hidden context.

10. **Enforcement at the service/store boundary, fail-closed.** The platform already declares a security model — `ModuleTrustDeclaration` (`trust.tier`) and `ModulePermissionDeclaration` (`network.outbound`, `filesystem`, `adminRoutes`, `sensitiveData`) — and a live policy layer (`src/modules/registry/security/permissionPolicy.ts`, `trustPolicy.ts`). The SDK exports the declarations but does not yet gate any surface on them. The document service must be wired to this policy, with scoping riding the store ownership layer (`src/server/core/documents/primary/base/ownership.ts`):
    - Reads fail closed when no access context can be resolved, the document is not visible at the requested ownership threshold, or ownership cannot be resolved.
    - Writes require both module trust/permission grants and document ownership at the required write threshold; otherwise a structured error (`permission_denied` / `out_of_scope`).
    - Unknown/ambiguous ownership blocks the operation; it is not a soft warning.
    - `commit` verifies each target operation before dispatch; no privileged internal batch path bypasses per-document checks.
    There is **no manifest document-scope gate** — documents are mutable, so the permission/ownership layer is the gate; a manifest declaration would add meaning the system does not need.

### D. Compendium and persistence

11. **Compendium declaration = hydration intent, not an access gate.** `info.json` `compendiumPacks` declares which packs are hydrated (full documents available). A pack present in `game.data.packs` but undeclared is still readable at index level (harmless — the compendium store is read-only, no CRUD). The only fail-closed rule is that a read for something **not present in `game.data.packs` or the compendium at all** does not reach into Foundry (a live fetch that cannot resolve). This preserves the passive seeding and cache-first hydration of ADR-0020/0021. The read API is `runtime.compendium` (`findOne` / `findAll` / `getById`), present on both the adapter's base runtime (`initialize`) and the route's `req.runtime`.

12. **`DataStore` for backend module persistence.** `PersistentCache` (`src/server/core/cache/PersistentCache.ts`) is raw and cache-connoted (`get`/`set`/`delete` only). The SDK exposes a durable, bounded `DataStore` on the runtime instead:

    ```ts
    interface DataStore { get<T>(key): Promise<T|null>; set<T>(key, value): Promise<void>; delete(key): Promise<void>; has(key): Promise<boolean>; keys(prefix?): Promise<string[]>; }
    ```

    Module-owned local data only (preferences, generated indexes, cached computations); no Foundry reach, not compendium reads, not secrets. Keys are flat logical names validated against path separators and reserved names. `PersistentCache` becomes internal backing; modules never import it. This is the server-side durable counterpart to the client `useModuleSettings` (decision 19).

13. **Storage boundary under the module cache dir.** Today both module data (`cache.get(moduleId, key)`) and compendium backing (`CompendiumStore` writing `manifestKeyFor`/`shardKeyFor` under namespace = systemId, `src/server/core/compendium/CompendiumStore.ts`) land flat in `<DATA_DIR>/cache/<moduleId>/`. Split them: `<DATA_DIR>/cache/<moduleId>/datastore/<key>.json` for `DataStore`, `<DATA_DIR>/cache/<moduleId>/compendiums/` for compendium backing — so `DataStore.keys()` never returns pack shards or platform metadata. This is required for `keys()` to be correct; implement it when wiring `DataStore`. Compendium shards re-hydrate from `game.data`, so migration cost is low.

### E. Adapter purity and hook relocation

14. **Pure projection adapter; read-only runtime; drop the `client` parameter.** Projection hooks do not receive a `ModuleFoundryClient`. The runtime passed to `adapter.initialize(runtime)` is the **read-only base** (decision 5): `documents` is `ReadonlyDocumentStore` (get/list/fetchByUuid) — no CRUD. Adapters never mutate the store; if a hook needs to transform a document it works on a **copy** in memory (which is what projection already is — `normalizeActorData` returns a new shape), never writing back. Writes only exist on a route's `req.runtime`. Keep the actual signatures:

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

    **Addendum (Phase 5 finding — compatibility validation is declaration-based, not verification-based).** Module compatibility (`evaluateModuleCompatibility` → `getCoreContractRegistry()`) only checks a module's *declared* `info.json` `compatibility.apiContracts` semver against the host's advertised contract versions (`module-api`/`ui-extension-api`/`roll-engine-api`, all `1.0.0` in `contractRegistry.ts`). It does **not** verify that an installed module's pre-compiled bundle actually resolves against the current SDK surface. This surfaced when the Phase 5 subpath split moved `useSDK` (and the rest of the client surface) out of the bare `@sheet-delver/sdk` barrel: a module packaged against an earlier `1.0.0` SDK still declares `module-api`/`ui-extension-api` `>=1.0.0 <2.0.0`, the host still advertises `1.0.0`, so the admin view reports it **valid** even though its compiled imports no longer resolve. Root cause: we evolved the SDK surface with breaking changes **without bumping the contract versions**, so the semver signal is stale. Two levers, both intended for the post-stabilization follow-up:
    - **Versioning discipline (primary).** The `API_CONTRACT_VERSIONS` / `contractRegistry.ts` versions are *the* compatibility signal. A breaking change to a surface MUST bump its contract major (the client subpath split + removed `onActorChanged` is a breaking `ui-extension-api`; the server runtime changes are a breaking `module-api`). Bumping the host's advertised majors to `2.0.0` makes every module declaring `<2.0.0` correctly report **incompatible**; conformed modules re-declare `>=2.0.0`. During in-development churn the SDK has stayed at `1.0.0`, which is why the check has been blind — to be reconciled when the SDK surface is frozen.
    - **Runtime health surfacing (secondary).** Declaration semver can never prove a pre-compiled bundle's imports resolve. Since installed modules now load at runtime via the ESM route with per-module try/catch (they are no longer bundled — see the implementation-plan note under Phase 4), a load **failure** should mark the module incompatible/unhealthy in the admin view rather than leaving it "valid". The runtime load result, not just the declared contract, should feed the admin status.

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
    - keep recognizing `apiRoutes` / `export { apiRoutes }`; continue rejecting `export *` (no `createApiRoutes` factory — runtime arrives on `req.runtime`);
    - drop reliance on TSX asset imports (no `file`/`dataurl` loader) in favor of `assetUrl()`;
    - gate packaging on `module:check` — a non-conforming module is not packageable.
    `next.config.ts` currently aliases only the exact `@sheet-delver/sdk` (turbopack + webpack blocks); add `@sheet-delver/sdk/react|server|testing` prefix aliases, and the browser import rewriter / global map in `createModuleRouter.ts` (`GLOBAL_MAP`) must expose the subpath globals (server-only rejected from UI). `init-module` generates no per-module webpack/next config — only `tsconfig.json`, `info.json`, a starter stylesheet, and templates — so there is nothing generated to migrate; its templates should model `assetUrl()` and the static `apiRoutes` + `req.runtime` shape, and avoid bundler asset imports.

30. **Contract tests and testing utilities.** `@sheet-delver/sdk/testing` provides a mock host (mock `ModuleRuntime`, the wired services, and SDK providers). Per ADR-0025, SDK changes need contract tests, not just type exports: a fixture module using only public SDK APIs must render a sheet, fetch/mutate through the runtime, send a roll, process a realtime change, resolve a declared compendium document, persist via `DataStore`, and resolve a packaged asset URL. Removed compatibility surfaces get no module-facing deprecation window; any staging bridge is internal-only per decision 31 and absent from the fixture surface.

### L. Removal (no compatibility window)

31. **`ModuleFoundryClient` and the broad client surface are removed — not deprecated.** Consistent with the design stance (conform modules to the SDK, not the reverse), the broad client is removed from the module surface **as part of the server SDK change in Phase 1**, not kept as a deprecated-but-available shim. It is not on the request, not passed to adapter hooks, and not a supported module API. Removal is gated on the SDK landing, **not** on module migration — the SDK does not wait for the modules. Modules break and are conformed per their phase (`dnd5e` Phase 3, `morkborg` Phase 6, `shadowdark` Phase 7); `module:check dnd5e` is allowed to fail between Phase 1 and Phase 3 by design. If staging the work across commits needs a temporary bridge, it is **internal only** (core wiring, never exported, never module-facing) and deleted within the SDK work — it is not a module deprecation surface. Adapter `client` parameters and `resolveActorNames` are removed in the same breaking change (decision 14), which requires relocating `getSystemData` and `performAutomatedSequence` first (decision 15). Internal transports and stores — `CoreSocket`, `ClientSocket`, route clients, registry satellites, compendium stores — are never exposed through SDK shims (ADR-0022, ADR-0026).

---

## Consequences

**Positive**

- Modules write system-specific projection and presentation; the platform owns document access, identity, realtime, modals, page hosting, persistence, and asset serving.
- Singleton services + a cheap per-request `req.runtime` handle; no per-request service re-instantiation, no module-facing `getInstance()`, no broad client on the request.
- Least-privilege is enforced by the core ownership layer; document ops default to the calling user (`req.userSession`) with `{ access }` as the explicit non-norm override — clean call sites without hiding the acting subject.
- The `dnd5e` page-shell duplication is deleted; behavior drift between modules and the platform is structurally prevented.
- Build and release tooling cannot drift from validation (shared config), and dev/packaged behavior is identical for assets/CSS.

**Negative / risks**

- This is a breaking SDK revision. `dnd5e` will break during the work and must be conformed; `morkborg` and `shadowdark` require rewrites.
- The subpath entry-point slice (B/K) is coordinated across externals, checker, browser rewriter, and `next.config.ts`; partial application breaks dev or packaged loads.
- The `DataStore` storage-boundary split (D) is a one-time on-disk layout change; compendium backing re-hydrates, but the migration must run before `keys()` is relied upon.
- Readiness-blocking semantics (decision 25) must not let a module wake or restart the Foundry transport through timing (ADR-0017/0021).

---

## Implementation Plan

Phases are sequenced so each slice is independently verifiable. Checkpoints are markable as work lands. A phase is "done" only when its checkpoints and the relevant Verification items pass.

### Phase 0 — Baseline and policy

- [x] Record current `module:check dnd5e` as a baseline, explicitly not a contract to preserve.
- [x] Extract a shared build-config module consumed by `check-module.ts` and `package-module.ts` (decision 29). — `src/scripts/tools/modules/build-config.ts`; both tools consume it.
- [ ] Document the SDK boundary policy: public entry points only; no module-facing compatibility shims or deprecation windows — breaking changes land and modules conform (decisions 1, 2, 31).
- [ ] Fix stale server-route docs (`docs/MODULE_AUTHORING.md`) to current `ModuleRouteHandler` + `json()`/`error()` usage.

### Phase 1 — Server runtime, services, access, persistence

- [x] Rename `ModuleContext` → `ModuleRuntime`; flatten the `platform` wrapper; update `createModuleRuntime.ts` and the `sdk-integrity.test.ts` assertions (decisions 3, 4). — files also renamed `runtime.ts` / `createModuleRuntime.ts`; verified green (unit suite + `module:check dnd5e`).
- [x] Mount document/roll/table services as singletons and wire them onto `ModuleRuntime` (`documents`, `rolls`, `tables`); module code never calls `getInstance()` (decision 5). — base runtime memoized per module (`ModuleProxyService.getBaseRuntime`); `req.runtime` adds user-bound `documents`/`rolls`/`tables` via `createModuleRequestRuntime`.
  **Addendum (audit follow-up, 2026-06-04).** Base `ModuleRuntime.documents.fetchByUuid()` is now wired via `DocumentResolver` with live compendium UUID fallback disabled, so adapter/bootstrap reads have the promised read-only UUID surface instead of throwing `not_ready`.
- [x] Implement the generic type-keyed `PrimaryDocumentStore` surface incl. `commit`, `fetchByUuid`, `effects`, and list query (filter/sort/page/limit) (decision 6). — `moduleDocumentServices.ts`: `STORE_BY_TYPE` (11 stores), `makeReads`, `createDocumentStore` (create/patch/upsert/delete/commit/effects over `dispatchDocument`), `applyQuery`.
  **Addendum (audit follow-up, 2026-06-04).** Route `req.runtime.documents.fetchByUuid()` no longer exposes raw resolver results for world UUIDs. Direct world UUIDs resolve through the same subject-scoped Store read path as `get()`, and embedded world UUIDs require the caller to see the root parent before the resolver may return the embedded child. Covered by `module-document-store.test.ts`.
- [x] Attach `req.runtime` per request (base + user-bound `documents`/`rolls`/`tables`, defaulting to `req.userSession`); static `apiRoutes` contract; `getAccessContext()` for overrides (decision 8). — wired in `ModuleProxyService.dispatchModuleRoute`; `ModuleServerRequest.runtime` now required, `ModuleServerExport = { apiRoutes? }`.
  **Addendum (audit follow-up, 2026-06-04).** `getAccessContext()` is now a required request method and is attached by `ModuleProxyService`; it derives `userId` from the request session or route client, re-derives `role` from `UserStore`, computes `isGM`, and throws `permission_denied` if no caller context exists.
- [x] Wire permission/trust + ownership enforcement; reads/writes fail closed; `commit` verifies per-op (decisions 9, 10). — route `DocumentStore` (`moduleDocumentServices.ts`): scoped reads fail closed when no subject resolves; writes require WRITEABLE (OWNER) ownership via `store.canReadDocument` (false for missing docs → ambiguous ownership blocks); the `{ access }` override trusts only `userId` (role re-derived from `userStore`, not caller-claimed); `commit` verifies every op before dispatching any. Trust/permission is install-time (no manifest document-scope gate — decision 10), so the live write gate is ownership. Covered by `src/tests/unit/sdk/module-document-store.test.ts`.
- [x] Add `DataStore` on the runtime and the `datastore/` vs `compendiums/` storage boundary; make `PersistentCache` internal (decisions 12, 13). — `DataStore` (`get/set/delete/has/keys`) on `ModuleRuntime`, backed under `<moduleId>/datastore/`; `PersistentCache` no longer SDK-exported. `CompendiumStore` backing relocated to the `<systemId>/compendiums/` sub-namespace (`packNamespaceFor`), a sibling of `datastore/`, so the two never collide and `DataStore.keys()` cannot observe pack shards/manifest. No migration needed — shards re-hydrate from `game.data`; stale flat-layout files are left orphaned and re-seeded under the new path.
  **Addendum (audit follow-up, 2026-06-04).** `DataStore` now validates flat logical keys before delegating to `PersistentCache`: empty keys, `.`/`..`, path separators, null bytes, and reserved storage names (`datastore`, `compendiums`, `manifest`) are rejected; `keys(prefix)` rejects traversal-style prefixes. Covered by `module-datastore.test.ts`.
- [x] Make service calls readiness-aware (block until ready; `not_ready` on unreachable) (decision 25, server half). — `awaitWorldReady()` (`worldReadiness.ts`) blocks on `systemService` readiness with a bounded wait, surfacing `not_ready` only if readiness can't be reached; gated into route `documents`/`rolls`/`tables` (injectable for tests). Deliberately NOT applied to the adapter's base runtime (it runs mid-bootstrap). The client cache/cross-surface dedup half of decision 25 is Phase 2.
- [x] Eliminate `getActorRaw` / `dispatchDocument` / `dispatchDocumentSocket` reach-ins (decision 6). — module surface no longer exposes the broad client (removed in Phase 1), so modules reach documents only through the typed `req.runtime.documents` store; `dnd5e` (kept green) has no reach-ins. Remaining references are core-internal plumbing (Repositories, sockets, `CombatService`, `CacheCoordinator`, `CompendiumService`) or `shadowdark`/`morkborg` module code conformed in Phases 6/7 (their `module:check` is allowed to fail until then — decision 31).
- [x] Add `SdkError` taxonomy + `json()`/`error()` response helpers (decision 24). — `src/shared/sdk/errors.ts` (`SdkError`, `SdkErrorCode`, `SDK_ERROR_STATUS`, `isSdkError`); `json()`/`error()` in `server.ts`.
  **Addendum (audit follow-up, 2026-06-04).** The module Express router now preserves thrown `SdkError`s at the boundary, returning their `status`, `code`, and message instead of collapsing them into a generic 500 response.
- [x] Relocate `getSystemData` (source from `runtime`) and `performAutomatedSequence` (module-authored route); then **remove** `ModuleFoundryClient` from the module surface, the adapter `client` parameters, and `resolveActorNames` — breaking, no module-facing shim; `dnd5e` is conformed in Phase 3 (decisions 14, 15, 31). — `ModuleFoundryClient`/`FoundryClient` deleted; `getSystemData()`/`normalizeActorData(actor)` drop the client; `resolveActorNames`/`performAutomatedSequence` removed from the adapter; `req.foundryClient` gone; `init-module` template + `sdk-integrity`/`actor-normalization` tests conformed. Verified: `tsc --noEmit`, `lint`, `test:unit`, `module:check dnd5e` all green.

### Phase 2 — Client sheet SDK and surface hosting

- [x] Export `ActorSheetProps`, `useActorSheet` (actor-focused), and `createActorPage`; make `actorPage` optional with a default platform host (decision 16). — `client-hooks.ts`: `useActorSheet` returns `{ actor, loading, notFound, isOwner, foundryUrl, refresh, roll, update }` (rollMode/speaker defaults centralized); `createActorPage(Sheet)` hosts a presentational sheet. `ActorPageRouter` now resolves `actorPage` → else `createActorPage(sheet)` → else `GenericActorPage`.
- [x] Add `useDocument` / `useDocumentMutation` client hooks; remove item/effect CRUD from `useActorSheet` (decision 17). — `useDocument(type,id)` (read+subscribe via `useSyncExternalStore`) and `useDocumentMutation(type)` (`create`/`patch`/`delete` + `embedded`); `useActorSheet` is actor-focused only (no item/effect CRUD).
  **Addendum (audit follow-up, 2026-06-04).** The client hook/cache machinery remains generic and type-keyed so it can grow without a redesign, but primary-store parity is not a promise that every primary document is a supported module-facing client capability. The production client transport intentionally remains Actor-first: modules normally consume permission-checked, sheet-ready actors and actor Item mutations, while Journals, Combat, ChatMessages, Users, Cards, RollTables, and the other primary stores remain core-owned client surfaces until a concrete module use case justifies an allowlisted, projected API. Server module routes retain the broader type-keyed `runtime.documents` surface; focused capabilities such as `runtime.tables.draw` remain preferable to exposing client document CRUD merely because a Store exists.
- [x] Add `SurfaceHost` (host-owned error + loading boundary + style-scope root) and wrap every dynamic surface: actor page, `tools`, `dashboardTools`, `rollModal` (decision 18). — `SurfaceHost.tsx` (first React error boundary in `src/client`) wraps `ActorPageRouter`, `ToolPageRouter`, `SystemTools`, and `CombatHUD`'s rollModal; emits a `sd-surface-root` scope anchor (data-surface/data-module) for decision 28. Wrapping `tools`/`dashboardTools` also gives them SDK context they previously lacked.
- [x] Provide host-supplied runtime identity (`moduleId`, `worldId`, `system`) via the provider; stop `/system/data` identity discovery (decision 19). — `worldId` lifted out of `FoundryContext` (was internal `lastWorldId`); `SDKContextValue` gains `moduleId`/`worldId`; `SurfaceHost`/`SDKProvider` inject `moduleId` per surface. Module-side removal of any `/system/data` identity probing rides Phase 3 conformance.
- [x] Back data hooks with a host-owned cache (dedup + realtime invalidation); expose no query library (decision 25, client half). — `createClientDocumentSource` is an **app-level singleton** (`getClientDocumentSource`) so a dashboard card and an open sheet share one fetch; concurrent reads dedup on the in-flight promise; a single `actorChanged` listener in `SDKProvider` invalidates the key (every mounted surface refreshes from one source); mutations write through + invalidate; `resetClientDocumentSource` clears on logout/world change. No query library is exposed. Covered by `src/tests/unit/client/document-source.test.ts`.

### Phase 3 — Prove it with dnd5e (conform)

- [x] Migrate `dnd5e` to `req.runtime` / static `apiRoutes`, the client sheet SDK, and document hooks; expect breakage and conform it (design stance). — `dnd5e` ships **no** server entry (manifest declares only `ui`/`logic`); it uses the platform `/api/actors` surface, so there were no module `apiRoutes` to migrate. Client conformed to the sheet SDK: the `Sheet` consumes `ActorSheetProps` and the host's `useActorSheet` provides load/roll/update through the host-owned cache.
- [x] Remove the hand-rolled page-shell duplication; keep the visual sheet module-owned; restore the dropped `rollMode`/`speaker`/item/shared-content behavior via the platform host. — deleted `src/ui/ActorPage.tsx` and dropped `actorPage` from the manifest so the platform default host (`createActorPage(Sheet)`) renders the module's visual sheet. `rollMode`/`speaker` defaults are restored by `useActorSheet.roll`; shared-content is rendered by the default host (`SharedContentModal`), which the old dnd5e page never showed. (dnd5e is read+roll+field-update; it has no item/effect CRUD.)
- [x] Leave the `dnd5e` adapter as the canonical pure-projection example; keep `module:check dnd5e` green from here on. — adapter is pure projection (`normalizeActorData(actor)`, no client/reach-ins); `module:check dnd5e` green (info.json, import boundary, module tsconfig typecheck, dry bundles all pass).

### Phase 4 — Compendium, assets, styles, settings, capabilities, events

- [x] Implement `runtime.compendium` hydration-intent semantics + fail-closed unknown reads (decision 11). — the reader only ever touches the offline `CompendiumStore`, so the sole fail-closed rule (no live Foundry fetch for unknown reads) holds by construction. Declaration is no longer an access gate: `getById` with a fully-qualified `Compendium.<pack>.<Type>.<id>` UUID resolves any pack *present* in the system (undeclared-but-present readable), returning null offline when absent. Query reads (`findOne`/`findAll`) stay scoped to declared packs of the requested `type` — not as a gate but because the declaration is the reader's authoritative type→pack map (the Store's row query is type-agnostic) and in-memory pack metadata isn't system-scoped. Covered by `module-context-compendium-packs.test.ts`.
- [x] Implement `assetUrl()` and extend the asset route to serve local-dev modules; drop TSX asset imports (decision 27). — `buildModuleAssetUrl(moduleId, path)` helper + `SDKContextValue.assetUrl(path)` (bound to the surface's `moduleId`) → `/api/modules/<id>/assets/<path>`. The asset route (`createModuleRouter.ts`) now resolves installed **and** local-dev modules (`getLocalModulesDataDir()`) via `resolveModuleBaseDir`, so the same URL works in dev and packaged. dnd5e's TSX `import '../../assets/dnd5e.css'` dropped — the platform injects the declared `stylesheet` via `<link>` to that route.
- [x] Implement runtime CSS scoping under the `SurfaceHost` root + the `module:check` global-leak lint (decision 28). — `SurfaceHost` adds a `sdk-module--<id>` class to the surface root (runtime-only; identical dev/packaged, no build-time CSS rewrite). `dnd5e.css` conformed: `:root`→`.sdk-module--dnd5e` tokens, `[data-theme]` and component selectors scoped under it (`@import`/`@keyframes` stay global). New postcss-based `style-scope` lint in `check-module.ts` fails on any selector not scoped under `.sdk-module--<id>` (skips `@keyframes`/`@font-face`/`@import`, descends into `@media`); verified it catches `:root`/bare-class leaks. Visually confirmed against the running dnd5e sheet.
- [x] Implement `useModuleSettings` + `info.json` `settings` schema (decision 21). — `ModuleSettingDeclaration` added to `ModuleInfo.settings`; `useModuleSettings(schema?)` is a self-contained reactive hook (per-`worldId+moduleId` localStorage namespace, `useSyncExternalStore` so all consumers sync, schema-seeded defaults) — the client counterpart to `DataStore`. (dnd5e's `useSheetSetting` left in place for now; conversion is optional polish tied up with the deferred theme/CSS work.)
- [x] Implement `SDK.capabilities.supports(...)` (decision 23). — `capabilities.supports(cap)` + `SDK_CAPABILITIES`/`SdkCapability` (`capabilities.ts`), reporting the features this SDK build exposes (documents/rolls/tables/compendium/effects/combat/settings/assets/events). Asserted in `sdk-integrity`.
- [x] Implement the realtime/event signal bus across all document types; retire actor-only `onActorChanged` (decision 20). — `SdkEvents`/`SdkSignal` (`events.ts`); host bus `createSdkEventBus` maps every `<type>Changed`/`<type>ListInvalidated` socket event to `document:changed`/`document:listInvalidated` (Combat included, no special-casing), plus `content:shared` and `connection:changed`/`world:ready`/`world:teardown` from the status stream. `SDKContextValue.events` replaces `onActorChanged`; the host document cache now invalidates via `events.on('document:changed')` (all types). Covered by `src/tests/unit/client/sdk-event-bus.test.ts`.
- [x] Add `adapter.dispose?(runtime)` courtesy teardown on world state transition (decision 22). — optional `dispose?(runtime)` on `SystemAdapter`; `WorldBootstrapper` retains the `initialize` runtime as `activeRuntime` and calls `dispose` fire-and-forget in `clearActiveAdapter` (reached via `reset()` on disconnect), so a slow/throwing dispose never blocks the transition. Covered by `world-bootstrapper.test.ts`.
- [x] Add `parseRollResult` and the chat-card render contract (decision 15). — `parseRollResult(raw, fallbackFormula?)` in `utils.ts` (server-side counterpart to `simulateRoll`; flattens Foundry `Roll.toJSON()`/`rolls.roll` shapes into `{ formula, total, terms?, dice? }`, extracting dice from `terms[].results[]`). `ChatCard`/`ChatCardRoll`/`ChatCardButton` render contract added to `interfaces.ts`; `componentStyles.chat` already existed and pairs with it. Covered in `sdk-integrity`.

**Addendum — module loading isolation + the compatibility-validation gap (Phase 5 finding).**

- **Pre-compiled installed modules are no longer in the build graph.** The generated `module-ui-registry.ts` used to emit a static `import()` for each installed module's compiled `dist/ui.js` (`dataModuleUIs`), pulling those bundles into the turbopack/webpack graph — so a single stale or malignant installed module with an unresolvable import (e.g. an old bundle importing `useSDK` from the bare barrel after the Phase 5 subpath split) failed the **entire** build. The generator now bundles only local-dev source (`localModuleUIs`); `dataModuleUIs` is always empty and installed modules load **at runtime** via the ESM route `GET /api/modules/:id/ui`, where `getUIModule`'s per-module try/catch degrades a failing module to the generic manifest. Local-dev source remains bundled by design (it must compile; a compile failure is the author's feedback). This made the latent coupling explicit: the host build must never depend on an installed module's compiled import shape.
- **Compatibility validation reports "valid" for runtime-incompatible installed modules** — see the addendum under decision 23. The admin view trusts the declared `apiContracts` semver, which we did not bump across breaking SDK surface changes, so a stale installed module reads as valid while its bundle won't load. Resolution levers (contract-version discipline + surfacing runtime load health) are recorded there for the post-stabilization follow-up; not yet implemented.

### Phase 5 — Tooling conformance

- [x] Subpath entry points + package `exports`; checker allows only the SDK family (decisions 2, 29). — `index.ts` trimmed to shared types/utils; new entry barrels `entry-react.ts` (client surface) and `entry-server.ts` (route helpers + runtime types); `testing.ts` reserved. Subpaths mapped in the generated `.managed/tsconfig.paths.json` (via `start-server`) so tsc + module tsconfig resolve `@sheet-delver/sdk/react|server|testing`. Internal imports repointed to precise source files; dnd5e client imports moved to `/react`.
- [x] Wildcard externals for SDK subpaths + React in checker and packager (decision 29). — `build-config.ts` `LOGIC_EXTERNALS`/`UI_EXTERNALS` now wildcard (`@sheet-delver/sdk/*`, `react/*`, `react-dom/*`), shared by the checker dry-bundle and the packager so subpath imports are externalized, never bundled.
- [x] Checker keeps recognizing static `apiRoutes` (no `createApiRoutes` factory); packaging gated on `module:check`; drop asset loaders (decision 29). — checker still recognizes `export const apiRoutes` / `export { apiRoutes }` and now rejects `export *` on the server entry; `package-module` runs `checkModule` first and aborts on failure; `BUILD_LOADER` is JSON-only (no file/dataurl asset loaders).
- [x] `next.config.ts` subpath aliases + browser rewriter/global map subpath globals (server-only rejected from UI) (decision 29). — turbopack + webpack aliases for `/react`,`/server`,`/testing`; `GLOBAL_MAP` maps `@sheet-delver/sdk/react` → `window.__SD.sdkReact` and `SDKGlobalProvider` exposes it; `/server` deliberately unmapped + a checker rule rejects it from UI bundle source files.
  **Addendum (audit follow-up, 2026-06-04).** The checker now follows local static, re-export, and dynamic imports from the declared UI entry and rejects `@sheet-delver/sdk/server` from every source file reachable by the browser bundle, including plain `.ts` / `.js` helpers. The previous `.tsx`-extension-only rule allowed a UI helper to import the deliberately unmapped server entry. Covered by `module-init-scaffold.test.ts`.
- [x] Update `init-module` templates to model `assetUrl()` + static `apiRoutes` over `req.runtime` (decision 29). — server template imports from `@sheet-delver/sdk/server` and uses `req.runtime`; UI Sheet template models `useSDK().assetUrl(...)` from `@sheet-delver/sdk/react`; no bundler asset imports.
  **Addendum (audit follow-up, 2026-06-04).** The initializer is now conformed to the completed sheet and runtime contracts instead of merely mentioning them: it omits the unnecessary custom `actorPage` so the platform hosts the sheet, types the generated sheet with `ActorSheetProps`, provides a real `assetUrl()` fallback asset plus a checker-compliant scoped stylesheet, and demonstrates `json()` / `error()` with parent-scoped `req.runtime.documents.items.create(...)` rather than attempting lowercase world-Item creation. The generated README describes the public entry, asset, and server directories. The generated tree now lives as reviewable `.tmpl` files under `src/scripts/tools/modules/scaffolds/init-module/`; `init-module.ts` only renders tokens and copies the tree, failing if a placeholder remains unresolved. Covered by `module-init-scaffold.test.ts`.
- [x] Ship `@sheet-delver/sdk/testing` mock host + the contract-test suite (decision 30). — `testing.ts`: `createMockModuleRuntime` (in-memory documents/rolls/tables/dataStore/compendium), `createMockDocumentSource`, `createMockSdkEvents`, `createMockSdkContext`/`createMockSdkComponents`/`MockSDKProvider`. Contract test (`src/tests/unit/sdk/contract.test.ts`) drives a fixture module over the public SDK only: renders a sheet via `createActorPage`→`useActorSheet` (`renderToStaticMarkup`), fetches/mutates + rolls + resolves compendium (incl. UUID) + persists via DataStore through the runtime, processes a realtime `document:changed`, and resolves an `assetUrl()`.

### Phase 6 — Migrate Mörk Borg

- [ ] Replace the removed generic adapter with `BaseSystemAdapter`.
- [ ] Export static `apiRoutes`; move server ops to `req.runtime` (default-to-caller, `{ access }` override).
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
- [ ] A module route reads/writes documents, rolls, and UUID lookups through `req.runtime` (defaulting to the caller; `{ access }` override); no `getInstance()` in module code, no broad client on the request.
- [ ] `adapter.initialize(runtime)` receives the read-only base runtime (no document CRUD); adapters never mutate the store.
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
