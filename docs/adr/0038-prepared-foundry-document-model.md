# ADR-0038: Prepared Foundry Document Model

**Status:** Accepted - In Progress
**Date:** September 16, 2026
**Supersedes:** None
**Revises:** ADR-0027 (actor normalization lifecycle)
**Related:** ADR-0011, ADR-0012, ADR-0013, ADR-0028, ADR-0034

---

## Context

Sheet Delver's primary-document Stores hold the authoritative source documents
received from Foundry. This is the correct persistence and synchronization
boundary, but it is not equivalent to Foundry's client-side document model.

Foundry constructs typed client documents from source data and runs a
preparation lifecycle over them. Core document classes prepare common data,
embedded documents and active effects participate in that lifecycle, and the
active game system derives system-specific values such as armor class,
proficiency, skill totals, resource limits, and roll data. Those prepared
values are client memory and are not generally written back into the source
document transmitted over the socket.

Sheet Delver currently performs portions of that work at request time through
`normalizeActorData`, `computeActorData`, card builders, and roll builders.
This creates several problems:

- the actor list, actor sheet, card, and roll paths can observe different
  interpretations of the same source revision;
- expensive preparation is repeated for each request and user;
- modules duplicate Foundry system preparation without one lifecycle contract;
- derived state has no revision, provenance, readiness, or failure diagnostic;
- realtime invalidation can be delivered before a later request has a current
  prepared model to read.

The Combat encounter read model demonstrates the desired ownership split:
source Stores remain authoritative, a core-owned read model follows source
changes, and authorization is applied after derivation. Actors need the same
kind of explicit prepared boundary, with system rules supplied by the active
module.

## Decision

Sheet Delver will introduce a core-owned, revisioned prepared-document model.
The first supported prepared document is `Actor`; additional document types
must be added deliberately rather than inferred from this decision.

### 1. Keep source, prepared, and projected data distinct

The three data classes have different authority and lifetimes:

1. **Source document:** canonical Foundry data held by the primary-document
   Store and updated only through normalized Foundry persistence ingress.
2. **Prepared document:** a deterministic system interpretation of one source
   revision, owned and cached by core.
3. **Projection:** a request- or user-specific view derived from a prepared
   document after authorization and visibility checks.

Prepared data never replaces or mutates the source Store. A prepared value is
not proof that Foundry persisted that value. Writes continue through source
repositories and requesting-user transports.

### 2. Core owns lifecycle; modules own system rules

Core owns a `PreparedActorStore` and its coordination policy. It subscribes to
Actor source changes, assigns monotonically increasing source revisions,
prepares the changed Actor, and atomically publishes the new prepared entry.
Deletes remove the entry.

The active system adapter owns one pure, deterministic preparation function:

```ts
prepareActorData(actor, context): PreparedActorData
```

The function receives a defensive copy of the source Actor and immutable
context. It must not perform transport, filesystem, clock, random, or
user-specific work. Data needed from compendiums or configuration must be
loaded during module initialization and captured as stable module state before
the world becomes ready.

The first contract is intentionally synchronous. Foundry's own document
preparation is synchronous, current module computations are synchronous, and a
synchronous contract lets core publish a prepared revision before source-event
handling returns. If a future system genuinely requires asynchronous
preparation, that change requires a separate lifecycle decision.

### 3. Provide a bounded compatibility bridge

`BaseSystemAdapter.prepareActorData` will temporarily compose the existing
`normalizeActorData` and `computeActorData` methods. Existing adapters therefore
enter the prepared lifecycle without changing behavior immediately.

First-party modules will then implement or inherit the explicit preparation
contract and remove request-specific duplicate computation. The legacy methods
remain supported during this migration, but new module guidance uses
`prepareActorData` as the canonical entry point. Removing the bridge requires a
future SDK-major compatibility decision.

### 4. Record revision and provenance

Each prepared entry records at least:

- Actor ID;
- world/runtime epoch;
- source revision;
- system ID and system version when available;
- module ID and module version when available;
- preparation state and diagnostic on failure.

The prepared payload is published only if its epoch and source revision are
still current. Runtime teardown clears every entry and advances the epoch so a
result from a departed world cannot become visible in a later world.

Preparation failures are isolated per Actor. Core records a bounded diagnostic
and does not silently return the raw source as prepared data. Other Actors and
the world remain available. Reads of the failed Actor receive an explicit
service error until a later source revision or rebuild succeeds.

### 5. Build prepared state before world readiness

World bootstrap ordering becomes:

1. accept the Foundry snapshot and source documents;
2. hydrate module-declared compendium data;
3. seed primary-document Stores;
4. initialize the active adapter and its stable preparation inputs;
5. configure and rebuild the prepared Actor Store;
6. mark the world ready and expose routes.

If the initial prepared rebuild cannot establish the store-level invariant,
bootstrap fails and clears partial runtime state. Individual malformed Actors
may be retained as failed entries under the isolation rule above.

### 6. Publish before invalidating clients

For create and update events, core prepares and publishes the new Actor entry
before forwarding `actorChanged` to application sockets. For deletes, core
removes the prepared entry before forwarding the event. A client that reacts to
the invalidation can therefore read the corresponding prepared revision.

Actor list invalidation caused by ownership changes remains sourced from the
authoritative Actor Store. It is forwarded only after preparation processing
for the same source event has completed.

### 7. Apply authorization outside preparation

Preparation is user-invariant. Ownership, role, visibility, and route policy
continue to use authoritative source documents and authenticated session
context. Core must never place a requesting user, visibility decision, hidden
GM state, or session credential into a shared prepared entry.

List, detail, card, and roll projections first authorize against source data,
then consume the corresponding prepared model. This prevents shared caches
from leaking user-specific projections while allowing all read paths to agree
on system-derived values.

### 8. Use prepared Actors across all Actor reads

After migration, these paths consume the same prepared Actor revision:

- Actor dashboard/list summaries;
- Actor cards;
- Actor sheet/detail data;
- item categorization used by Actor views;
- roll data and initiative inputs.

Recursive UUID/content enrichment remains a projection concern unless the
module declares the resolved value to be part of its deterministic prepared
model. Request handlers must not run the old normalization/computation chain a
second time.

### 9. Keep the SDK surfaces explicit

The SDK will export prepared Actor and preparation-context types. Existing
`runtime.documents` remains a source-document surface; it will not silently
change meaning. A future module-facing prepared-document read API, if needed,
must use an explicitly named surface and preserve source access for writes and
identity checks.

The canonical SDK/API version declarations remain in
`src/shared/sdk/contractVersions.ts`. Any compatibility declaration change is
made there and propagated through normal module release tooling; version
numbers are not duplicated in the prepared Store.

## Consequences

- Core gains a durable equivalent to the portion of Foundry's client document
  lifecycle Sheet Delver can reproduce outside the Foundry browser.
- Modules still implement system rules, but implement them once instead of in
  competing list, sheet, and roll paths.
- Source synchronization and write behavior remain unchanged.
- Actor mutations consume additional CPU once per source revision and prepared
  entries consume additional memory. Request-time duplication is reduced.
- A broken module preparer becomes visible as a bounded Actor diagnostic rather
  than producing silently inconsistent UI.
- Exact parity with a Foundry system remains a module responsibility and must
  be tested against representative Foundry-prepared values.
- Extending preparation to Items, Scenes, Tokens, or other documents requires
  evidence of need and an explicit contract amendment.

## Implementation Plan

- [x] Add prepared Actor SDK types and the adapter preparation contract.
- [x] Implement the core `PreparedActorStore` with revisions, epochs,
      diagnostics, teardown, and source-event binding.
- [x] Rebuild prepared Actors after adapter initialization and before world
      readiness.
- [ ] Move Actor list, detail, card, roll, and initiative reads to prepared
      Actors while retaining source authorization.
- [ ] Order Actor realtime invalidation after prepared publication.
- [ ] Add unit and integration coverage for source immutability, updates,
      embedded changes, deletion, failures, epoch rejection, authorization,
      and realtime ordering.
- [ ] Update module-authoring and architecture documentation.
- [ ] Migrate and parity-test the D&D 5e module.
- [ ] Migrate and parity-test the Shadowdark and Mork Borg modules.
- [ ] Complete generation 13 and generation 14 live acceptance before closeout.
