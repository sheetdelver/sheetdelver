# ADR-0067: Foundry package context and optional compendium artwork

**Status:** Implemented — isolated verification passed; operator confirmed display
**Date:** 2026-10-21

## Context and scope

A Shadowdark user installed `shadowdark-community-tokens` and requested its
monster portraits instead of the native cowled placeholder. Native Foundry's
browser applies compendium art during document construction; the server's source
Actor can still contain the placeholder. Importing native browser code or having
each SheetDelver module fetch manifests would duplicate lifecycle and access
policy. The user selected a shared SDK capability, with Shadowdark as its first
consumer. D&D and other modules can adopt it separately.

Core base: 0.19.8, commit `9ae8442d18445a0472a1be4236c8f6b973e7008b`.
The authorized branch is `feat/sdk-foundry-package-context`. This is an additive
contract, not a migration amendment. ADR-0064/0065/0066 stay closed for their
completed scopes. No application version, native source, Actor image, Token,
world setting, or installed native package is changed by this implementation.

## Decision and ownership

Core projects the accepted native bootstrap `GameData.system/modules` envelope
through `FoundryPackageService`. It does not inspect the host filesystem or
fetch package inventories during bootstrap. A ready snapshot contains world ID,
revision, system/modules, ID/title/version/kind, enabled state, a declaration-only
`compendiumArt` capability and readable pack descriptors. Missing module inventory
is **unavailable**, not an empty installation; missing `active` is unknown (`null`).
Raw manifests, download URLs, flags, ownership and credentials are not exported.
An installed/enabled package is neither a content permission nor proof that its
browser scripts work in SheetDelver. Only packages in the observed world envelope
can be reported; it is not a setup-wide inventory of every server installation.

Public contracts in `src/shared/sdk/packages.ts`:

- `runtime.packages?.snapshot()` — immutable native package metadata, no I/O.
- `runtime.artwork?.resolve(canonicalUuid, 'image' | 'token')` — exact compendium
  Actor/Item identity to optional artwork. Image means Actor portrait or Item image;
  token supports Actor texture only. Results are `resolved`, `none`, `unavailable`.
- `useFoundryPackages()` from `@sheet-delver/sdk/react` — caller-filtered browser
  snapshot, retired on world/user/role/connection changes, teardown and unmount.
- `world:packagesChanged` — preference revision notification, separate from rules.
- Protected GET `/api/module-packages` and `/api/module-artwork?uuid=...&kind=...`
  provide the same projection/resolver. Responses use `Cache-Control: no-store`.

SDK 3.5.0/module-api 1.7.0 add server contracts; ui-extension-api 3.3.0 adds
hook/event contracts. `src/shared/sdk/contractVersions.ts` remains the only
contract-version authority. Roll API and application version are unchanged.
Capabilities are optional so older-host consumers can retain original artwork.
A mandatory adoption must declare the corresponding API minimum in its manifest.

Adapter runtime access is server-trusted. `createModuleRequestRuntime` replaces
its package/art handles with caller-bound handles, using current native pack
visibility and request-scope checks. Browser routes likewise authenticate the
session and current user. Asset results are checked again after asynchronous
loading against world revision and pack visibility. Resolving art does not prove
that the document exists and never grants document access: consumers must first
read the exact source through their authorized document/collection contract.

Core owns discovery, authorization, preference interpretation, asset loading and
lifecycle. Modules own whether the source image should be replaced in a view.
The prepared/source stores are unchanged; artwork is a presentation projection.
No guessed names, duplicate world caches, browser-required server behavior or
private Core imports are introduced.

## Resolution and lifecycle

The resolver accepts modern `flags.compendiumArtMappings[systemId]` providers
from the active system and enabled native modules. It interprets
`core.compendiumArtConfiguration` portraits/tokens/items switches independently.
Foundry v14 fills omitted switches with true; v13 treats an existing provider
configuration as-is, so omitted switches are disabled there. Item artwork is
available for v14; v13 remains Actor-only. Unqualified native generations return
`unsupported-version`. Explicit ascending priority wins; unspecified providers follow explicit ones in
native inventory order. Exact pack and document IDs select `img`/legacy `actor`
or `token.texture.src`/token-string fields. It does not convert same-name content.

Only HTTP(S) asset URLs on the configured Foundry origin and route prefix under
`modules/` or `systems/` are accepted. A mapping must reside inside its declaring
package. Credentials, query strings, fragments, traversal and redirects are
rejected. Fetches send no authentication headers. Mapping reads are lazy, limited
to 2 MiB and 1.5 seconds per file, deduplicated, and cached for five minutes
(success) or ten seconds (failure). There is no new asset fetch, compendium scan
or readiness gate at bootstrap. Image loading remains the browser's ordinary
asset request; the consumer restores its original image if optional art fails.

Preference changes retire cached mappings and emit their own revision. They do
not change the rules snapshot or request migration/maintenance. World teardown
aborts pending mappings; same-world recovery refreshes adapter handles; a new
world retires them. Native package installation/activation changes are observed
on fresh native bootstrap/reconnect, not through filesystem polling. User and
role changes use the existing lifecycle signals and fresh caller projections.

## Deliberate limits

This is not arbitrary Foundry module execution or full native compendium-art
emulation. No package scripts, browser Hooks, legacy system-specific art flag
conversion, external/CDN mappings, arbitrary asset directory browsing or token
scale/rotation overrides are executed. Malformed preferences or failed
higher-priority mappings return unavailable and preserve the source image. Native
Foundry may continue with a lower provider after a mapping failure; that failure
behavior is deliberately not claimed as equivalent. Asset file changes with no
setting/reconnect notification are visible after cache expiry and a fresh read.

Module metadata is visible to authenticated users, with pack lists separately
filtered. Asset URLs are ordinary installed public Foundry assets, not a private
content delivery or redistribution permission. Consumers must preserve credits
and check content licenses before distributing artwork. No third-party art is
bundled by this change.

## Native reference and acceptance

Native references: Foundry v14.367 and v13.351
`client/helpers/media/compendium-art.mjs`, symbols `getPackages`, `_registerArt`,
`#parseArtMapping`, `applyArt`. The source-only comparison harness reads a supplied
local native file and records its SHA256; it does not vendor native source.
Shadowdark4.0.6 reference commit `9677d16b3903b3b640f00d4efd48249142ac8334`:
`system/src/config.mjs` default NPC portrait and `data/packs/monsters.db/*.json`
bundled placeholders. Community tokens1.3 declares its mapping in `module.json`.
Its local installation and public mapping were observed; actual native world
activation has not been asserted. Controlled acceptance explicitly sets active
in its isolated upstream and reads installed assets without changing them.

| ID | Requirement | Maintained verification |
| --- | --- | --- |
| P67-01 | Complete/unknown metadata, immutable projection, zero bootstrap I/O | `src/tests/unit/world/foundry-packages.test.ts` |
| P67-02 | Exact identity, native priority and independent switches | same suite; `src/tests/acceptance/foundry-art-native.ts` |
| P67-03 | Caller visibility, lifecycle, malformed/oversized/failed assets | unit suite; public installed Shadowdark acceptance |
| P67-04 | Abort and retire browser state without stale results | `src/tests/acceptance/foundry-packages.browser.mjs`; SDK event-bus test |
| P67-05 | Original/custom portrait preservation, installed image fallback | Shadowdark `src/tests/community-artwork.test.ts`, `installed-consumers.core.ts --artwork-only` |
| P67-06 | No native writes or maintenance for optional artwork | installed controlled-upstream source/write assertions |

Commands: `npm run test:unit`, `npm run test:integration`, `npm run lint`,
`node node_modules/typescript/bin/tsc --noEmit --incremental false`.
Native comparison: `node --import tsx src/tests/acceptance/foundry-art-native.ts
--reference=<native-client-file>`. Mounted hook: set `PLAYWRIGHT_MODULE` and
optionally `CHROME` to development-only installations, then run
`node src/tests/acceptance/foundry-packages.browser.mjs`. It blocks network access.
See Shadowdark's module-owned audit for installed archive and visual results.

### Verification closeout — October21

- Full Core unit/client and integration suites, explicit typing and lint pass.
  Package-specific coverage comprises13 resolver groups and eight mounted hook
  requests/transitions, including late responses, world/user/role changes,
  teardown, reconnect and unmount. No live server is used by those checks.
- Native method comparisons:12 cases each against v13.351 and v14.367.
  Native file SHA256s: v13
  `9629b8d69544624c63766d9c15ac8484199e73792b616c16fe8e755cde74b506`,
  v14 `5d1c572001ed262518f6b5a03cda8a5d58a5df81b1eb71fffb3959f025592fbc`.
  `client/game.mjs::setupPackages` and `client/packages/module.mjs` independently
  confirm that native module active state comes from the accepted game envelope.
- Real isolated production build/start and managed Shadowdark archive acceptance
  pass7/7, as does the development-host run. Protected metadata/artwork routes,
  desktop/mobile cards, live preference retirement, image-error fallback and zero
  native writes are verified. No uncaught page errors. This is a controlled
  upstream, not an actual native-world session.
- Production Core source-tree SHA256:
  `20d07087cd113b97a90913ff1bcf363c8b03c05bb047b4e6a493b7cf13ddb93f`.
  Shadowdark archive282785bytes, SHA256
  `1a185c0cab0b7cb8fb3e0e83a96862d09521c172ecfdfcb67ad3023b2a82d3f1`.
  Module18 source suites, explicit types/check/package and52 mounted cases pass.
  Desktop/mobile artwork screenshots were visually reviewed.

All task-owned services stopped. Operator Foundry was left running. SDK/artwork
changes remain uncommitted; release and operator acceptance are separate.

## Addendum: optional module display policy for combat — October21

The user requested combat artwork without assuming every system uses Shadowdark
placeholders or compendium mappings, and specifically requested authoring coverage.
Implement `SystemAdapter.resolveDisplayArtwork` as an optional policy hook. The
new SDK types in `displayArtwork.ts` describe source Actor, current image and its
origin, purpose, minimal Token display metadata, caller-bound read-only runtime
and abort signal. Return `{src, credit?}` or null. No module registration flag or
Core system-specific branch is added. No further contract bump is needed within
the same uncommitted SDK3.5/module-api1.7 work.

`DisplayArtworkService` freezes cloned context, bounds the optional hook to3s,
checks current scope/source after settlement and validates returned asset URLs.
`registerDisplayArtworkRoutes` reconstructs inputs from authoritative stores and
existing combat redaction. Manager requests need GM/Assistant. An unreadable
Actor is not disclosed to the module simply because its combat row is visible.
The runtime excludes write/roll/chat/DataStore APIs. Trusted module code must use
that supplied runtime; a timeout does not sandbox/preempt JavaScript or authorize
continuing side effects.

Core's `DisplayArtwork` consumer renders the original image immediately and fetches
optional art independently. Combat manager roster and HUD portraits use it with
their existing, different image precedence. Failed/retired/unsupported requests
retain the original; failed replacement/original assets settle to the existing
icon without a retry loop. Package/context/user/source/reconnect changes retire
pending work. There is no art-driven bootstrap or combat readiness work.

Shadowdark opts in through `ShadowdarkAdapter.resolveDisplayArtwork`, sharing its
exact default/origin policy. Custom currently displayed images decline even if
the base Actor's portrait is default. HUD Token/Combatant images request token art;
Actor fallback and manager portraits request portrait art. Missing origin or
older host capability preserves the original. Other systems may use their own
module assets or public read contracts, or omit the hook entirely.

The actor-card purpose and endpoint exist for explicit/future consumers;
**dashboard cards are not wired to it in this slice**. Existing `getActorCardData`
and module-owned UI retain their contracts. This boundary and the complete typed
example, access/asset rules, lifecycle, compatibility and adoption test checklist
are in `docs/MODULE_AUTHORING.md`.

Additional acceptance: P67-07 generic opt-in/decline/alternate module assets and
bounded failure; P67-08 manager/HUD authorization and existing image precedence;
P67-09 original-first browser lifecycle/fallback without combat blocking.
Maintained tests: `src/tests/unit/world/display-artwork.test.ts`,
`src/tests/acceptance/display-artwork.browser.mjs`, Shadowdark's artwork suite and
installed artwork harness. These extend, rather than replace, P67-01–06.

## Combat artwork verification — 2026-10-21

The optional display hook adds generic policy without Core system-specific logic.
Core contract suite passes 9 groups: omitted/declined hooks, alternate module-owned
assets, bad URLs/errors, stale scope, deadline/abort, manager/HUD precedence, empty
Actor portrait fallback, caller/Actor access, and hidden/unstarted rows. The mounted
actual consumer passes six controlled request transitions covering both `_id` and
`id` session shapes, original-first display, broken replacement/original, settings,
source mismatch, caller/world change, reconnect and unmount. Shadowdark's artwork
suite passes 7 groups; all 18 module source suites pass.

An initial installed production check found the new consumer only accepted `id`;
the actual native User shape uses `_id`. Corrected to the shared `_id || id`
precedence and expanded the mounted fixture. The final copied Core production
build/start and managed archive run passes **9/9**: protected discovery, installed
bestiary/card at 360/1440 widths, preference refresh, broken-image fallback, manager
portrait, HUD token, custom Actor/Token preservation, zero native writes. No page
or console errors. The manager screenshot was inspected. The earlier failed run
is retained as a diagnostic, not passing acceptance.

Final archive: `shadowdark-0.9.6.tgz`, 283460 bytes; SHA-256
`948eda06fcf4b82a69c18a045f66bd80cee22d74106821530d67ed6b61d32ab3`.
Core 0.19.8 base commit `9ae8442d18445a0472a1be4236c8f6b973e7008b`, tested working
`src` tree SHA-256 `5f16940f7b7369bd867cff237ac4b7c7742d6d728e6cb43b2152521596a5fc35`.
This supersedes earlier artifact identities for the combat-hook extension. The
archive was created before subsequent documentation/harness-only edits; runtime
module code is identical. Core unit/client/integration, explicit Core/module types,
lint and whitespace checks pass. The authoring guide's actual TypeScript example
was separately compiled against SDK exports.

Reproduction uses the maintained installed harness with `--run-isolated
--archive=<tgz> --out=<new-directory> --generation=14 --production --artwork-only
--community-art-root=<read-only-installed-package>`, configured temporary browser
tooling as documented in module AGENTS. Core checks use `npm run test:unit`,
`npm run test:client`, `npm run test:integration`, `npx tsc --noEmit`, `npm run lint`,
and `node src/tests/acceptance/display-artwork.browser.mjs`. Module typing uses
`node data/local/modules/shadowdark/src/tests/verify-types.mjs` from Core.

This is isolated real-host acceptance with synthetic native data and actual
read-only installed artwork; it is not fresh live native acceptance. Prior static
v13/v14 mapping comparisons remain applicable. Actual operator world activation
of the installed provider has not been independently observed. Dashboard cards
have not adopted this hook. No native data, app versions or module minima changed.
All test-owned services stop in cleanup. Operator Core 8000/8001 and Foundry 30000
remain running and untouched. No commit, push or release was performed.

### Encounter-copy artwork correction

Operator review exposed the Compendium-copy path omitted by the first installed
artwork fixture: `CombatManagerService.addPackActor` deliberately strips native
`_stats` and records the exact origin in its encounter-copy marker. The initial
hook looked only at native origins and therefore declined those copies. Core now
projects optional `DisplayArtworkContext.compendiumSourceUuid`, after verifying
Actor access, copy registration, matching encounter and folder, and a typed Actor
UUID. Shadowdark consumes this public field before native origins. Custom images
and pack permissions retain precedence. No names, private module imports, source
repairs or additional startup work are introduced. Existing copies can resolve
without recreation. Regression coverage includes the real public copy writer and
Core restart; the earlier world-Actor test alone did not verify this workflow.

## Compendium-copy correction verification — 2026-10-21

User's live screenshot showed default images for encounter-owned pack copies.
The initial installed artwork fixture supplied a native origin on a world Actor
and missed the real copy writer, which strips `_stats` while retaining its own
exact source marker. Added `DisplayArtworkContext.compendiumSourceUuid`, derived
by Core only after copy registration, encounter/folder agreement and typed Actor
UUID checks. Shadowdark consumes that public context before native origins.
No private Core flag parsing is added to the module. Existing sources remain
unchanged; custom images and caller pack permissions still apply.

Core and module regressions both failed before correction (missing origin and
missing replacement respectively), then passed. Core artwork suite: 10 groups;
Shadowdark artwork suite: 8 groups. Full Core unit suite, explicit Core/module
typing, lint, module check/package and the revised authoring example pass. The
previous full client/integration results remain retained; those unchanged suites
were not rerun for this server provenance correction.

Final isolated production build/managed acceptance passes **11/11**, including
the actual public `combat-manager/:id/pack-actors` operation, rendered copy before
initiative, and existing-copy resolution after Core restart. The controlled
fixture recorded three copy-creation writes and zero artwork/repair writes.
No page errors. The copied-participant screenshot was inspected. An intermediate
harness run omitted the normal mutation runtime header and correctly received
409; the final run sends the current public status token like the real UI.

Archive SHA-256:
`7b9cdbe334d2a4c244a4394b410246c707cbcdb26905cd0a5d1da5924898f585`.
Core working `src` tree SHA-256:
`837dc0c4cf7de7cd751d30088da2e81d7da2f5c7827a1e5fc754982547e80ee1`.
Core base/version remain `9ae8442d`/0.19.8; module remains0.9.6. Maintained harness
command is the previous production artwork command with a fresh corrected archive
and output directory. Local outputs: `/tmp/art-copy-production-final` and
`/tmp/art-copy-final/data/dist/modules/shadowdark-0.9.6.tgz`. Runtime code matches
the archive; later edits are documentation/harness-only.

Read-only inspection of installed package1.3 mappings confirms exact native4.0.6
IDs for Elephant, Demon/Dretch, Naga/Bone, Manta Ray/Giant and Assassin all have
portrait/token mappings. This does not independently establish live world enable
state. Test services stopped; operator ports8000/8001/30000 untouched. All
corrections remain uncommitted; no live native data changes or release operations.

## Operator acceptance and checkpoint authorization

On 2026-10-21 the user confirmed that the corrected artwork looks and works as
expected and authorized local Core/Shadowdark commits. This is operator-reported
acceptance of the current display behavior, additional to the isolated checks
above. No push, merge, tag or release is included. Optional module NPC viewers
remain a separate proposed scope under deferred DW-08/DW-13; no viewer component
contract is implemented by this artwork checkpoint.
