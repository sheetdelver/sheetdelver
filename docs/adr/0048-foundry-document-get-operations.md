# ADR-0048: Foundry Document Get Operation Alignment

**Status:** Completed — implemented and verified September 24, 2026
**Date:** September 24, 2026
**Related:** ADR-0011, ADR-0015, ADR-0016, ADR-0021, ADR-0034

## Context

Foundry's [`DatabaseGetOperation`](https://foundryvtt.com/api/interfaces/foundry.abstract.types.DatabaseGetOperation.html)
selects documents through `query`, not `ids`; `ids` belongs to delete operations.
Its pack-index projection uses `indexFields`, not `fields`. SheetDelver sent `ids` for targeted
world-root refresh, pack-document lookup, and chunked full-pack hydration.
Foundry ignores those selectors and can return an entire collection or pack.
The caller-side ID filter prevents unrelated Store writes, but overfetch makes
autosave/repair and diagnostic UUID reads needlessly expensive. Repeated
"chunks" can fetch the same whole pack many times.

The compendium service also labels an index as field-aware after a request
whose `fields` option Foundry ignores. A projection using `indexFields` must
request `_id` and `name` explicitly; otherwise the resulting row may lack
the identity/freshness fields needed by the shard and index contracts.

These are server transport request defects, not a change to Foundry document
identity, module preparation, player authorization, or the Combat Manager.

## Decision

1. Targeted world-root and pack-document `get` requests use
   `query: { _id: id }`. Keep response ID validation, world-epoch checks,
   Store routing and authorization behavior unchanged.
2. Declared full-pack hydration uses one `get` with `pack`, `index: false`
   and `query: {}`. Its purpose is to hydrate the entire declared pack; a
   non-working multi-ID operator or repeated pseudo-chunks add no value.
   Preserve ID de-duplication as a shard invariant.
3. `modifyDocument` index reads use `indexFields` for requested variants,
   including `_id`, `name`, `type`, `img` plus caller fields. Default index
   reads omit `indexFields` and retain Foundry's native default. A fallback
   that lacks requested fields must not be cached as that variant.
4. Keep legacy `getDocuments` fallback events, but pass `query` and
   `indexFields` in their operation objects where they share the get-operation
   shape. Do not change delete operations, which correctly use `ids`.
5. Make intentional whole-world bootstrap reads explicit with `query: {}`.
   This does not change their scope; they seed the registered primary Stores.
6. Do not make a broad transport abstraction or client-side Foundry runtime
   dependency. The existing server services own the correction.

## Verification

- Synthetic tests assert the emitted operation shape, projection integrity,
  targeted refresh and one-request full-pack hydration. The full unit suite
  passed on September 24, 2026.
- Read-only probes against disposable local Foundry v13.351 (Daggerheart) and
  v14.367 (Shadowdark) returned exactly one requested world Actor and pack
  Actor using `query: {_id}`. Both returned requested `indexFields` projections;
  v14 omitted `_id` when it was not explicitly requested. A v14 multi-ID
  `$in` query returned zero rows, so full hydration uses one whole-pack read
  rather than assuming that selector works. No production Core or hosted world
  was contacted. Both test servers were stopped and temporary license copies
  removed; disposable worlds and original licenses remain untouched.
- `npx tsc --noEmit` and lint of all changed source/test files passed.

## Consequences

Targeted reads should no longer transfer whole collections. Full hydration
remains deliberately whole-pack but requires only one request. Field-aware
indexes retain identity fields. Unverified legacy event behavior remains a
compatibility fallback, not a claim of native support; if a fallback cannot
return the requested projection, the service must not mislabel it as such.
