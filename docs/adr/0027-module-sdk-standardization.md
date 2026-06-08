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

   **Addendum (Phase 7 — importable logger + `console.*` ban).** `runtime.logger` (server) and `useSDK().logger` (UI) only reach code that holds a runtime/hook handle; **pure logic files** (e.g. `normalization.ts`, `rules.ts`) have neither, so before this they either imported the internal `@shared/utils/logger` (a boundary violation) or fell back to raw `console.*` (uncontrolled — no level gating, no module prefix). Conforming `shadowdark` made this the single largest violation class (23 `@shared/utils/logger` imports across logic + routes). Fix: `@sheet-delver/sdk` now exports a **late-bound** `logger` and `createModuleLogger(namespace)` usable in *any* module file. The sink defaults to `console` and is rebound to the platform logger during module bootstrap — server-side in `BaseSystemAdapter.initialize` (so an overriding adapter must call `super.initialize(runtime)`), client-side in `SDKProvider` (the SDK is a host singleton at `window.__SD.sdk`, so one bind reaches all module UI). With a sanctioned path in place, `check-module` now **fails** on direct `console.*` in module-authored source (new `logging` issue kind), exempting test files and vendored `temp/` reference trees (which are also now skipped by every module-file walker). This *completes* the logging contract rather than bending it to a module.

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

   **Addendum (Phase 7 — embedded parents at any depth, gated on the root).** The Phase 6 `effects`/`items` surfaces resolved their `parent` writeability via `requireStore(parent.type)` — which only knows *top-level* store types (`Actor`, `Item`, …). Conforming `shadowdark` surfaced the gap: it edits ActiveEffects that live on an actor's **owned item** ("Scale Effects"), whose parent is the embedded item, not a top-level document. The transport was never the limit — `dispatchDocument` builds `parentUuid = ${parent.type}.${parent.id}`, so the owned-item parent `{ type: 'Actor.<actorId>.Item', id: itemId }` already serializes to the valid Foundry uuid `Actor.<actorId>.Item.<itemId>`; only the SDK's writeability gate rejected the compound type (`requireStore` → `not_found`). This is a general shape, not an effects quirk: Foundry models documents as a tree (`Actor → Item → ActiveEffect`, and beyond), and a module that can write a document should be able to mutate its embedded members at any depth. Fix: `documents.effects`/`documents.items` now gate on the **root** document of the parent uuid (the first `type.id` pair) via `assertParentWriteable`, then forward the parent to `dispatchDocument` as before — so you may mutate an embedded child iff you can write the top-level document that ultimately owns it. This *completes* the embedded-mutation contract (decision 6) for arbitrary depth rather than bending it to a module; the parent type stays `{ type; id }` (a uuid), so it is additive.

   `Actor` is **not** a special surface; it was migrated into the primary stores alongside `Item`, `JournalEntry`, `Combat`, `RollTable`, `Macro`, etc. precisely so one uniform pattern serves all. Adding a store to the public surface is an allowlist decision, not new per-type API. Implemented (exposed) types: `Actor`, `Item`, `JournalEntry`, `Combat`, `RollTable`, `Macro`, `Playlist`, `Cards`, `Folder`, `User`, `ChatMessage`. Stub stores stay internal: `Scene`, `Adventure`, `Setting`, `FogExploration`. The reach-ins `getActorRaw` / `dispatchDocument` / `dispatchDocumentSocket` are eliminated and collapse into `documents.*` + `fetchByUuid`.

7. **Irreducible non-CRUD primitives only; richer behavior is module-authored.** Beyond the document store, the request runtime exposes `rolls.roll` (dice evaluation, structured result, no forced chat) and `tables.draw` (roll + match); `compendium` is available on both the base runtime and `req.runtime` (decision 11). `chat.send` is `documents.create('ChatMessage', …)`. Anything richer — attack sequences, level-up, combat turn control, formatted chat cards — is composed by the module author in their own routes over these primitives. The platform does not pre-bake an action for every system mechanic. `performAutomatedSequence`-style logic relocates here (decision 15).

   **Addendum (Phase 6).** Promoted `chat` to a first-class `req.runtime.chat` surface: `chat.send(message)` (post a raw ChatMessage — the module builds the body), `chat.card(card, options?)` (post the structured `ChatCard` render contract of decision 15 — the reusable "create a chat card" primitive; the rendered body goes to `content` and the full card rides a `flags.sheetDelver.chatCard` flag for a client renderer), and `chat.useItem(actorId, itemId)` (the default "uses item" card for an actor's item). `useItem` had no SDK equivalent during the `morkborg` conformance and several systems post a card on item-use / actions, so these are reusable primitives rather than per-module reimplementations. All three are user-bound and readiness-gated like the other request services.

   **Addendum (post-Phase 6, real-world chat conformance).** Two corrections surfaced once a *player* (non-GM) triggered module chat against a live Foundry world:
   - **Author defaulting.** The SDK dispatches the raw document straight to Foundry's backend, bypassing the client-side `author = game.user` default — and Foundry permits a non-GM to create a `ChatMessage` (or `Macro`) only when its `author` is themselves, so an unauthored create is denied. The acting user is now defaulted as `author` on every author-bearing create: `chat.send`/`chat.card` (in the chat runtime), and `documents.create`/`upsert`/`commit` for the author-bearing types (`ChatMessage`, `Macro`) in the document store. `rolls.roll` and `chat.useItem` already set it. A module may set `author`/`user` explicitly to override (e.g. a GM/system message). Other document types remain ownership-gated, not author-gated.
   - **rollMode visibility (public / private(gm) / self / blind).** `chat.send`/`card` map `ChatPostOptions.rollMode` through `resolveRollModeData` to Foundry whisper/blind: `publicroll` → visible to all; `selfroll` → whisper to self; `gmroll`/`private` → whisper to GMs (+ self); `blindroll` → blind + whisper to GMs. rollMode sets defaults; an explicit `whisper`/`blind` on the message overrides (manual targeting wins). Covered by `module-document-store.test.ts`.

   **Addendum (post-Phase 6, roll parameters + real dice).** `rolls.roll` stays a *no-forced-chat* evaluation primitive, but its parameters are now a documented `RollOptions` type so authors can drive posting rather than reach into untyped options: `displayChat` (post the roll to Foundry as a real roll message — registering it and triggering the dice animation; default `false`), `rollMode` (visibility when posted), `speaker`, and `flags`. Complementarily, `RollResult.rolls` exposes the evaluated roll(s) as Foundry `Roll.toJSON()` strings so a module that renders its **own** card can attach them to `chat.card({ rolls })` / `chat.send({ rolls })` and have Foundry register + animate the dice. This closed a real-world gap: morkborg evaluated rolls synthetically (`displayChat:false`) and posted only a content card with a dice *sound*, so no dice were ever rolled in Foundry — its card sends now include the result's `rolls` (public, no `type`/blind, so the card still renders) and Foundry rolls/animates the dice.

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

    **Addendum (Phase 7 — reads carry derived Foundry identity).** Conforming `shadowdark` exposed that `runtime.compendium` rows were hydrated *content* (full `system`/`effects`) but lacked *identity*: rows carried `_id` and no `uuid`/`pack`. That is faithful to how Foundry persists compendium documents — `uuid` is **derived** from pack context (`Compendium.<packId>.<DocType>.<id>`), never stored in `_source` — but the read boundary, which already iterates per declared pack, is the layer responsible for stamping the identity a consumer sees on a live document, and it wasn't. The consequence was real: a module that categorizes by pack could not, because `findAll('Item')` flattens every same-typed pack into one untagged list, and shadowdark has pairs that are *indistinguishable by Foundry `type`* (`gear` vs `magic-items` are both `Basic/Weapon/Armor/Potion`; `conditions` vs `spell-effects` are both `Effect`). Fix: `CompendiumStore.findAll` (the sole backing for `findOne`/`getById`, consumed only by the module runtime reader) now stamps each returned row — on a shallow copy, never mutating cache — with `pack` (the source pack id) and a derived `uuid` (`Compendium.<packId>.<type>.<_id>`, honoring any uuid already present), using the `type` argument it previously ignored as the uuid's DocType segment. Modules thus receive self-describing rows and recover pack provenance without reconstructing uuids; `morkborg` (which keys off Foundry `type`) is unaffected. This *completes* decision 11, it does not bend it to a module.

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

### M. Tailwind CSS

> **Addendum (post-Phase 6).** Conforming `morkborg` surfaced a gap that decision 28 did not foresee. Decision 28 assumed the platform's Tailwind utility layer "stays global and shared" for every module — which held only while modules lived in `src/modules/**` and were compiled as part of the host Next build. Once modules moved to the configured data directory — local-dev modules under `<DATA_DIR>/local/modules/<id>` (gitignored) and installed modules shipping **pre-compiled** artifacts under `<DATA_DIR>/modules/<id>` (no `.tsx` to scan) — that assumption breaks: Tailwind v4 auto-detection skips gitignored paths, and there is no source to scan for a packaged module. The result was a `morkborg` sheet that rendered structurally but lost every utility class (colors, borders, fonts) — a flat, unstyled surface. `dnd5e` was unaffected only because it ships hand-authored, semantically-classed CSS (`assets/dnd5e.css`) and never relied on the host utility layer. This section records how modules use Tailwind and how that styling is delivered; it **refines decision 28**.
>
> **`<DATA_DIR>` is configurable, never a literal.** `data/` is only the default; the data root is resolved from `$SHEET_DELVER_DATA` / `DATA_DIR` / CLI (`paths.ts` `resolveDataDir` → `getDataDir()`), and the local-modules dir from `getLocalModulesDataDir()` (overridable by `$SHEET_DELVER_LOCAL_MODULES`). Every path in this section and its implementation must derive from those helpers — `start-server.ts` already passes `SHEET_DELVER_DATA` to the Next process and resolves it in the generated PostCSS plugin, so no new code may hardcode a `data/` literal.

32. **Module authors use Tailwind utility classes inline; hand-authored CSS is not required.** A system sheet is a normal Tailwind-in-JSX component. The toolchain — not the author — is responsible for turning those utilities into a stylesheet that ships with the module. Hand-authored, semantically-classed CSS (the `dnd5e` model) remains valid and is not removed; it is simply no longer the only supported path. This keeps module authoring ergonomic and matches how the platform's own UI is built.

33. **Two-layer delivery, with visual parity but differing isolation.** A module's Tailwind-derived CSS is produced in two distinct ways depending on context, accepted as a deliberate trade rather than forced into one mechanism:
    - **Local dev (source present).** The host's existing dynamic PostCSS plugin (`.managed/postcss-plugin.cjs`, generated by `start-server.ts`, which resolves `$SHEET_DELVER_DATA` at generation time) injects `@source` globs so the host Tailwind build scans module `.tsx`. It already does this for the installed dir (`<DATA_DIR>/modules`) and the deprecated `src/modules`; it must also include the local-modules dir (`getLocalModulesDataDir()`, default `<DATA_DIR>/local/modules`) — derived from the resolved data dir, not a `data/` literal. This is a **dynamic glob over the discovered module dirs — never a hand-maintained list of module ids.** In dev the module's utilities land in the host's global, shared utility layer (unscoped). That is acceptable because the host uses the same layer and **only one system module is active per world**, so cross-module conflation cannot occur (this is the same reasoning that makes per-module duplication safe in decision 34).
    - **Packaged / installed (compiled, no source).** `module:package` compiles the module's author-owned Tailwind entry (`src/styles/tailwind.css`, decision 38) into a **self-contained** reserved artifact `assets/<id>.tailwind.css` (decision 37), tree-shaken to the utilities that module actually uses, wrapped under `.sdk-module--<id>` by a PostCSS pass, and auto-added to the manifest `stylesheet` (served via the decision-27 asset route). This is the portable, isolated form — it does not depend on the host scanning anything.
    The two paths render the same utilities (visual parity); they differ only in isolation (dev = global layer, packaged = scoped file). Because a single active module cannot conflate with another, the dev/packaged isolation difference is safe.

34. **A shared SDK theme supplies tokens by `@import`; nothing is merged.** Modules resolve the platform's design tokens (custom fonts such as `--font-imfell`, the base colors) from a shared SDK theme entry (`@sheet-delver/sdk/theme.css`) which the module `@import`s in its `src/styles/tailwind.css` (decision 38). That file is a `@theme inline { … }` block, so importing it *registers* the tokens (the module's `font-imfell` utility generates `font-family: var(--font-imfell)`) without emitting a duplicate `:root` block — the **values** are supplied at runtime by the host (`next/font` sets `--font-imfell` on the page). **Use `@import`, not `@reference`:** Tailwind v4's `@reference` puts the whole stylesheet in reference-mode and *suppresses* theme/base emission (it is meant for secondary `@apply` files), which would leave every `var(--color-*)` undefined — verified during implementation. Each module still compiles **independently** into its own file with content scanning confined to that module (the compile sets Tailwind's `base` to the module dir, otherwise auto-detection scans the whole platform repo and bloats every artifact with unused utilities); the theme is never copied between modules and module stylesheets are never globbed together. **Preflight is not duplicated:** the module compile *omits* Tailwind's base reset (decision 37) — the host already ships a global preflight on every page (`src/app/globals.css` → `@import "tailwindcss"`) that covers module elements too, in both dev and packaged. The module's compiled file therefore carries only scoped utilities + tokens, which keeps dev and packaged identical (one global host reset underneath in both).

35. **This refines decision 28's "no build-time CSS rewrite."** Decision 28 forbade a package-time CSS transform on the grounds it would break dev/packaged parity. That concern is answered, not ignored: dev parity is preserved by the host scanning local module source (decision 33, layer 1), so the package-time scoped compile (layer 2) produces the *same* visual result rather than a divergent one. The runtime-only `SurfaceHost` scope root (`.sdk-module--<id>`) from decision 28 stays exactly as-is and is what the packaged CSS is scoped to; Shadow DOM is still rejected for the same reason. The `module:check` style-scope lint continues to enforce scoping on hand-authored module CSS and must accept compiler-generated scoped output.

36. **Custom CSS and inline Tailwind coexist as separate stylesheets — composed by the cascade, never merged at runtime.** A module author may use any mix of three kinds:
    - **(a) inline Tailwind utilities**, compiled to the reserved `assets/<id>.tailwind.css` (decisions 33, 37);
    - **(b) plain static CSS** file(s) in `assets/` — `@font-face`, keyframes, bespoke component rules, vendored third-party CSS;
    - **(c) CSS that uses Tailwind directives** (`@apply` / `@layer` / `@theme` / `@variant`).

    Kinds (a) and (b) need no merge: multiple stylesheets compose through the normal CSS cascade, all under the single `.sdk-module--<id>` scope root, so a runtime merge would add latency for no benefit and is **not** done. The manifest `stylesheet` therefore widens from `string` to `string | string[]`, and the client injector (`src/modules/registry/core/client.ts`) emits one `<link>` **per entry**, deduped per href (today it injects one link guarded per module — that guard must move to per-href). Cascade order follows declaration order, with the compiled artifact linked first so author CSS can override utilities. Kind (c) is the one build-time constraint: `@apply`/`@layer`/`@theme` need the Tailwind compile context, so directive-using CSS cannot be a standalone static file — it must be a **compile input** (fed to the package-time Tailwind run, decision 33 layer 2) and ends up inside the compiled artifact. Net: utilities, static CSS, directive-using CSS, or any combination — the author's choice — and the platform composes them by linking separate scoped stylesheets.

37. **The compiled artifact has a reserved, toolchain-owned name; author CSS is never clobbered and always wins.** The package-time Tailwind output is written to a reserved generated path — **`assets/<id>.tailwind.css`** — that the packager exclusively owns and overwrites, that authors never hand-edit, and that is safe to gitignore in the module repo. This is the fix for the collision: auto-naming the compiled file `assets/<id>.css` would squat on (and overwrite) a name the author may legitimately want for their *own* custom CSS. With the reserved name, an author is free to ship `assets/<id>.css` / `assets/styles.css` as their custom stylesheet untouched. Two further guarantees keep the compiled utilities (and Tailwind preflight) from fighting author CSS:
    - **Order:** the compiled artifact is linked **before** author stylesheets (decision 36), so at equal specificity the author's rules win — the author has the last word.
    - **No module preflight (host provides it):** the module compile omits Tailwind's base reset; the host's global preflight already covers module elements in both dev and packaged (decision 34). So the compiled artifact contributes only scoped utilities + tokens and cannot reset the host page. A module that ships *only* custom CSS (no Tailwind entry) produces no compiled artifact at all. This was a deliberate choice (Option 2) over scoping a full per-module preflight: it gives the best dev/packaged parity (the divergence this whole section fixes), avoids a double reset, and needs no selector-prefixing dependency. The trade — the module assumes the host supplies a Tailwind-compatible reset — is safe because the host is always a Tailwind app.

38. **The package-time compile is entry-driven: the author owns `src/styles/tailwind.css`.** Rather than the packager synthesizing a hidden entry, the module ships an explicit Tailwind entry so authors see exactly what is compiled and have one obvious place to extend it:
    ```css
    /* src/styles/tailwind.css */
    @import "tailwindcss/theme.css" layer(theme);        /* design tokens */
    @import "@sheet-delver/sdk/theme.css";               /* platform tokens (font-imfell, base colors) — @import, NOT @reference */
    @import "tailwindcss/utilities.css" layer(utilities); /* the utility classes this module uses */
    /* preflight intentionally omitted — the host supplies a global reset (decisions 34, 37) */
    /* extend: @theme {…}, @layer components { .x { @apply … } }, @font-face, custom @source */
    ```
    **Why `src/` and not `assets/`:** the entry is authored *input* that is *compiled* — like `src/ui/Sheet.tsx`. `assets/` is served **as-is** by the asset route (decision 27); a raw entry containing `@import "tailwindcss"`/`@apply`/`@source` is not valid browser CSS and would break if served. The compile *output* (`assets/<id>.tailwind.css`, decision 37) is real CSS and belongs in `assets/`. `module:package` runs Tailwind on this entry with the module dir as the content `base` (confining scanning to the module — decision 34) plus an explicit `src/**` `@source`, and applies the `.sdk-module--<id>` scope-wrap — so the author's entry stays clean (content discovery and scoping are the toolchain's job; the entry is purely where the author imports the theme and adds their own `@layer`/`@apply`/`@font-face`, decision 36 kind c). A module with no `src/styles/tailwind.css` produces no compiled artifact (decision 37).

39. **`module:check` validates the Tailwind setup (and gates packaging on it).** Because the dev path (decision 33 layer 1) styles a module via host scanning *even when the module has no entry*, a module can look correct in `npm run dev` yet ship unstyled when packaged. The checker closes that trap:
    - **Dry-compile the entry.** If `src/styles/tailwind.css` exists, the checker runs the same package-time Tailwind compile (resolve `@import "@sheet-delver/sdk/theme.css"` → the SDK theme file, base-confine + `@source` the module, scope-wrap) and fails on: a missing/garbled entry, an unresolved import, a Tailwind/PostCSS error, or empty output. This also transitively proves the host toolchain deps (`tailwindcss`, `@tailwindcss/postcss`) resolve — those are **host** build deps, not module deps, so there is nothing for the module to declare.
    - **Required directives.** The entry must `@import "@sheet-delver/sdk/theme.css"` (so tokens resolve) and import the Tailwind utilities layer; the dry-compile is the authoritative check, with a clear message naming the missing piece.
    - **Detect the dev-only trap.** When `src/styles/tailwind.css` is *absent*, the checker probe-compiles the module's `src/**` against a synthesized default entry; if that yields a non-trivial set of utility classes (the module clearly uses Tailwind) it **fails** with guidance to add `src/styles/tailwind.css`. A module that yields no utilities (hand-authored-CSS modules like `dnd5e`) passes — the entry stays optional for them.
    - The existing `style-scope` lint (decision 28/35) still runs on hand-authored CSS and accepts the compiler-generated scoped artifact.

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
- [x] Document the SDK boundary policy: public entry points only; no module-facing compatibility shims or deprecation windows — breaking changes land and modules conform (decisions 1, 2, 31). — `docs/MODULE_AUTHORING.md` now documents the four subpath entry points (`@sheet-delver/sdk` / `/react` / `/server` / `/testing`) and the "missing SDK surface or module-specific code" rule; no shim/deprecation surface is described.
- [x] Fix stale server-route docs (`docs/MODULE_AUTHORING.md`) to current `ModuleRouteHandler` + `json()`/`error()` usage. — server-route section rewritten: static `apiRoutes` keyed by pattern, handler `(req, { params })`, `req.json()` is the request-body reader (not a response), responses via `json()`/`error()`, host access through `req.runtime` (no Foundry client). Also refreshed the adapter section (`initialize(runtime)` flat `ModuleRuntime`, no client on projection methods) and added an Assets section (`assetUrl()` / no binary imports / scoped CSS).

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
  - **Fix (real-world, surfaced testing morkborg):** a server-initiated change (a module roll updating the actor) reached the client socket but never refreshed the open sheet — only client-initiated edits (write-through) reflected, so the gap had gone unnoticed. Cause: `createSdkEventBus(appSocket)` bound the socket **inside `useMemo`** in `SDKProvider`, i.e. a render-time side effect; React renders a component more than once before commit (StrictMode/concurrent), so a discarded render's bus bound the socket while the committed bus — the one the `document:changed → invalidate` effect registered on — stayed unbound, silently dropping every event. Fixed by making the bus **pure** (`createSdkEventBus()` with no socket) and binding the socket from an effect via `attach()` / `detach()`, so the bus is stable and the socket + subscribers can't desync. Regression covered in `sdk-event-bus.test.ts` (a subscriber survives a socket re-attach). **Boundary:** `createSdkEventBus` and the host-only `attach`/`detach`/`dispose` live in `src/client/ui/sdk` and are never exported from any `@sheet-delver/sdk` barrel; the socket (the host's browser↔platform `appSocket`) is consumed only by `SDKProvider`. `SDKProvider` hands modules a narrowed `{ on }` facade (typed *and* shaped as `SdkEvents`) so a module cannot reach the bus's lifecycle methods and tear down or rebind the shared realtime bus — modules sit one stable signal interface away from the transport.
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

- [x] Replace the removed generic adapter with `BaseSystemAdapter`. — `MorkBorgAdapter extends BaseSystemAdapter`; `normalizeActorData(actor)` drops the client and resolves images via `resolveImage`. The preserved 925-line mechanics engine is fed a `req.runtime`-backed shim (`engineClient`) exposing the old `roll`/`createActorItem`/`sendMessage`/`useItem`/`dispatchDocumentSocket` method names, so the engine body is unchanged.
- [x] Export static `apiRoutes`; move server ops to `req.runtime` (default-to-caller, `{ access }` override). — `server.ts` exports static `apiRoutes` with only the SYSTEM-SPECIFIC routes that have no core equivalent: `actors/[id]/roll` (the sequence engine, which now also drives brew-decoctions/get-better), `generate-character`, and `items` (compendium item-picker). Generic actor read/field-update/item CRUD use the platform `/api/actors` surface; the old `getModuleFoundryClient` + `dispatchDocumentSocket` reach-ins are gone. The offline JSON `src/data/packs/*.json` were deleted — `createMorkBorgData(req.runtime.compendium)` reads `findAll('Item')`/`findAll('RollTable')` per request (failure-on-missing is intended; no offline fallback).
- [x] Move image handling to `assetUrl()`; remove TSX image imports. — the 8 `import grunge from './assets/*.png'` (Next static-image `.src`) imports were replaced with `buildModuleAssetUrl('morkborg', '<file>.png')`; the pngs were moved to the module's served `assets/` dir. No bundler asset loader is needed (`BUILD_LOADER` stays JSON-only).
- [x] Replace private UI imports with `useSDK`, `useSDKComponents`, `useActorSheet`, and document hooks. — `ActorPage` is a custom `actorPage` (decision 16 escape hatch — morkborg's rolls are a system-specific engine, not the generic platform roll): read/field-update via `useActorSheet`, roll sequences + brew via the module roll route, item CRUD via the platform actor-item surface; `RichTextEditor`/`resolveImageUrl`/`fetchWithAuth` via `useSDK`/`useSDKComponents`; no hand-rolled fetch/realtime. **Brew note:** the SpecialTab "Brew Decoctions" button (`onRoll('feat','Create Decoctions')`) and Get Better were latent dead paths — `getRollData` never mapped those keys to their automated types, and the `onBrewDecoctions` prop was passed to the sheet but consumed by no component. Conformance completed the `getRollData` mapping (`'Create Decoctions'`→`decoctions`, `getBetter`→`getBetter`) so both drive the engine's existing `performAutomatedSequence` branches through the single roll route; the redundant dedicated `brew-decoctions` route + unused `onBrewDecoctions` prop were dropped.
- [x] `module:check morkborg` passes. — passes (info.json, import boundary across 31 source files, root-tsconfig typecheck, dry bundles for logic/ui/server). Platform `tsc --noEmit`, `lint`, and `test:unit` all green.
- [x] Styling parity restored (Phase 6.5): dev fixed by the Layer 1 `@source` change; packaged styling via the `src/styles/tailwind.css` entry → compiled `assets/morkborg.tailwind.css`.

### Phase 6.5 — Resolve Tailwind / CSS

Make Tailwind-authored modules render correctly in both local dev and packaged installs (section M). Lands before Phase 7 so `shadowdark` (same inline-Tailwind approach) inherits the fix rather than re-discovering it.

- [x] Extend the generated dynamic `@source` plugin (`start-server.ts` → `.managed/postcss-plugin.cjs`) to include the local-modules dir (`getLocalModulesDataDir()`, default `<DATA_DIR>/local/modules`) alongside the existing `<DATA_DIR>/modules` / `src/modules` globs — derived from the resolved data dir (no `data/` literal). Restores local-dev Tailwind for `morkborg`/`shadowdark`. Dynamic glob, no per-module list (decision 33, layer 1). — added a `LOCAL_MODULES` block (honors `$SHEET_DELVER_LOCAL_MODULES`, falls back to `path.join(DATA_DIR,'local','modules')`); regenerated plugin validated (`node --check`) and smoke-tested to emit `@source "…/data/local/modules/**/*.tsx"`. Verified live: after a `npm run dev` restart, morkborg's styling is restored.
- [x] Add a shared SDK theme entry (`@sheet-delver/sdk/theme.css`) exposing the host design tokens (fonts, base colors) for `@import`; confirm the runtime token vars (e.g. `--font-imfell`) are host-supplied so module CSS only emits `var(...)` (decision 34). — created `src/shared/sdk/theme.css` mirroring the host `@theme` block (`--font-imfell`/`--font-crimson`/`--font-inter`/sans/mono + `--color-background`/`--color-foreground`); `@theme inline` so utilities emit `var(...)`; values set by `next/font` in the root layout. Modules `@import` it (NOT `@reference` — `@reference` suppresses theme emission).
- [x] Preflight handling — **decided Option 2:** the module compile *omits* preflight; the host's global reset (every page loads `globals.css` → `@import "tailwindcss"`) covers module elements in dev and packaged (decisions 34, 37). Best dev/packaged parity, no double reset, no selector-prefixing dependency.
- [x] Add a package-time Tailwind compile to the shared `build-config` / `package-module` path, **entry-driven** off the author-owned `src/styles/tailwind.css` (decision 38): resolve `@import "@sheet-delver/sdk/theme.css"` → the SDK theme file, confine scanning to the module (`base` = module dir + explicit `src/**` `@source`), scope-wrap under `.sdk-module--<id>`, and write the reserved `assets/<id>.tailwind.css` (decision 37); record it as `info.compiledStyles` so the injector loads it first (decision 33, layer 2). No `src/styles/tailwind.css` ⇒ no compiled artifact. — `tailwind-compile.ts` (`compileModuleTailwind` + scope PostCSS plugin); packager writes the artifact + sets `compiledStyles`. **Discovered during impl:** without `base` = module dir, Tailwind auto-detection scans the whole repo (every artifact bloats with platform-wide utilities + leaks unrelated classes); `base` confines it to the module (morkborg 104 KB, dnd5e 5.8 KB, both leak-free). Verified by packaging morkborg: `assets/morkborg.tailwind.css` present, `info.compiledStyles` set.
- [x] `module:check` validates the Tailwind setup (decision 39): dry-compile `src/styles/tailwind.css` when present (fail on unresolved `@import`, compile error, or empty output; require the `@import "@sheet-delver/sdk/theme.css"` + Tailwind utilities import); when absent, probe-compile against a synthesized entry and fail if it yields utilities (the dev-only-styling trap); keep the `style-scope` lint accepting the compiled artifact (decision 35). — `checkTailwind` in `check-module.ts`; `module:check` green for morkborg + dnd5e.
- [x] Keep hand-authored scoped CSS a valid path; the Tailwind compile is optional and a module may still ship its own stylesheet (decision 32). — preserved by construction and verified: a module that uses **zero** Tailwind utility classes needs no `src/styles/tailwind.css` (the checker's no-entry probe returns 0 → passes), and its hand-authored CSS loads via the `stylesheet` declaration (string | string[]). (`dnd5e` itself is now a *hybrid* — it uses utilities too — so the pure-hand-authored path was validated with a separate zero-utility probe rather than via dnd5e.)
- [x] Support multiple stylesheets so custom CSS and compiled Tailwind coexist (decision 36): widen the manifest `stylesheet` to `string | string[]`, and update the client injector (`src/modules/registry/core/client.ts`) to emit one deduped `<link>` per entry (per-href guard) with the compiled artifact (`info.compiledStyles`) linked first. Route directive-using CSS (`@apply`/`@layer`) through the compile as an input rather than a separate static file. — done: `UIModuleManifest.stylesheet: string | string[]`, packager-managed `ModuleInfo.compiledStyles`, injector rewritten (per-href dedup, compiled-first then author entries); tsc green.
- [x] Conform `init-module` (decision 29): scaffold the author-owned Tailwind entry `src/styles/tailwind.css` (the `tailwindcss/theme.css` + `@sheet-delver/sdk/theme.css` (`@import`) + `tailwindcss/utilities.css` layer imports, preflight omitted — decision 38) so new modules are Tailwind-ready; the scaffold's hand-authored `assets/styles.css` remains a coexisting declared stylesheet (the hybrid — decisions 36/32). — added `scaffolds/init-module/src/styles/tailwind.css`; the scaffolded `Sheet.tsx` now models Tailwind utilities alongside the `sheet-*` semantic classes (the hybrid), and the README has a Styling section covering both paths. The `module-init-scaffold` unit test (which runs `module:check` on the generated module) passes. `tsconfig.json` and the CI workflow are unaffected.
- [x] Also gave `dnd5e` an entry (it generates real utilities → would fail decision 39's no-entry probe; it now demonstrates the hybrid: 5.8 KB compiled Tailwind + its hand-authored `dnd5e.css`, both scoped). `module:check dnd5e` stays green.
- [x] Prove it on `morkborg`: confirmed `assets/morkborg.tailwind.css` (104 KB) contains only morkborg's utilities, scoped under `.sdk-module--morkborg`, no platform leak; `module:check morkborg` + a full `module:package morkborg` succeed. Live dev visual restored by Layer 1; packaged-visual confirmation is the user's to eyeball on install.
- [x] **Installed-module loading fixes (surfaced by packaging morkborg).** Two bugs blocked the packaged custom `actorPage` (it fell back to `GenericActorPage`): (1) the `/api/modules/:id/ui` import rewriter copied esbuild's `import { x as y }` collision-renames verbatim into a destructuring pattern (`const { x as y } = …`) — a **syntax error** that failed the whole UI manifest load for any multi-component module; fixed to emit `const { x: y } = …` (extracted to `rewriteModuleImports.ts` + regression test `module-ui-rewrite.test.ts`). (2) `info.compiledStyles` (decision 37) lives only on the packager-patched **artifact** info.json, not the **source** info.json bundled into `ui.js`, so the client injector couldn't see it — the `/ui` route now re-exports it (`__sdCompiledStyles`) and the client (`registry/core/client.ts`) injects from there. So an installed Tailwind module now loads its custom page **and** its compiled scoped CSS.

### Phase 7 — Migrate Shadowdark ✅

- [x] Fix manifest UI entry, syntax errors, duplicate exports, and the `export *` server shape first.
- [x] Replace the cache-scanning registry with `runtime.compendium` + `runtime.documents`. `Registry.ts` no longer touches `PersistentCache` / `fs` / `info.json`; its categorized collections + nameIndex are an in-process derived projection over the platform compendium (sourced by `findAll('Item'|'RollTable')`, grouped by the now-stamped `pack`), with UUID hydration via `runtime.documents.fetchByUuid`.
- [x] Replace internal compendium/document/socket access with runtime services; replace private UI contexts/components with SDK hooks. Every route runs on `req.runtime` (`getModuleFoundryClient` + `client.*` gone); the adapter extends `BaseSystemAdapter`; ~20 UI files moved to `useSDK()` / `useSDKComponents()`; ActorPage realtime rides `events.on('document:changed')`; the UI→server-adapter bundle leak (a dead `talent-handlers` import) was severed.
- [x] `module:check shadowdark` passes (import-boundary, logging, style-scope, Tailwind compile, typecheck, all dry bundles), and `dnd5e` + `morkborg` still pass.

  **Completion note (Phase 7).** Conforming shadowdark — the largest, most entangled module — drove four SDK contract *completions* (not module-specific bends), all recorded as decision addendums above: the importable `logger` + `console.*` ban (decision 4), embedded-parent writeability at any depth (decision 6), compendium rows stamped with derived Foundry identity (decision 11), and the client/server log-sink binding. Roughly 16 dead routes/files (per-field randomize wrappers, roll-table routes, `gear.ts`, `tables.ts`, duplicate handlers, a dangling spellcaster route) were removed after verifying — against the Generator and level-up flows — that no functionality was lost.

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
- [x] `dnd5e`, `morkborg`, and `shadowdark` all pass `npm run module:check`.

---

## Verification status

- [x] Phases 0–7 checkpoints complete (all three modules — `dnd5e`, `morkborg`, `shadowdark` — conformed and passing `module:check`; platform `tsc` / `lint` / `test:unit` green).
- [ ] Phase 8 (boundary closeout confirmation) outstanding — audit committed entry exports + confirm no staging bridge remains.
- [ ] Verification criteria fully satisfied (pending the Phase 8 confirmation pass).
- [ ] Contract test suite green in CI.
