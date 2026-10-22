# ADR-0068: Optional module compendium reference views

**Status:** Implemented — isolated acceptance and operator review complete; final closeout pending
**Date:** 2026-10-21
**Owners:** Core/SDK contract; adopting modules own reference presentation

## Decision

Provide an optional module UI extension for informational views of exact compendium
sources. The first Core consumer is the combat manager: show a View reference link
only when the active module supplies a suitable viewer and the current caller can
read the exact referenced source. Shadowdark should reuse the visual presentation
of its bestiary reference card. The contract accommodates Actor and Item sources
from the outset; Item links in other Core surfaces are future consumers, not part
of this initial integration.

This is a reference view of the original compendium content: artwork, description,
reference stat block and other informational fields supplied by the module. It is
not a live participant sheet or encounter-data projection. Do not substitute the
copied Actor's current HP, effects, equipment or other instance changes. No roll,
cast, use, edit, import, spawn or encounter action controls belong in this view.

No provider, unsupported source, unknown origin, missing source, or denied access
means no reference link. Preserve the combat manager's ordinary selection/details
behavior. Do not synthesize a generic reference card when a module has not opted in.
A later disappearance/revocation must retire the open content and pending result
with an accessible explanation; do not retain stale private data.

## Existing foundations and authority

- `src/shared/sdk/interfaces.ts::UIModuleManifest` already has lazy module UI
  surfaces for sheets, tools and roll dialogs. Extend that public pattern rather
  than loading arbitrary component paths supplied by native documents or URLs.
- `src/client/ui/components/SurfaceHost.tsx` supplies SDK context, style scope,
  Suspense and error handling. Reuse it and the shared dialog/overlay behavior.
- ADR-0067 provides package/artwork context and verified encounter-copy provenance
  through `DisplayArtworkContext.compendiumSourceUuid`. Reuse the underlying exact
  source resolution where appropriate; do not overload the image-returning hook
  with React components or reference payloads.
- `CombatManagerService.addPackActor` stores copy origin separately from native
  `_stats`. Support already-existing copies; no recopy, migration or source repair.
- Shadowdark's `ResourceDetailModal` and bestiary server/card preparation establish
  a presentation reference, not an existing Core viewer contract. Inspect/extract
  a reusable informational body while preserving its established artwork, type,
  title, typography and notes. Do not embed a second competing dialog shell.

Modules own presentation and system-specific interpretation. Core owns identity,
caller authorization, transport, lifecycle and the mounting boundary. Core must
not contain Shadowdark-specific card markup, default paths or monster rules.

## Contract requirements

1. Optional public module UI declaration identifies supported document types and
   lazy viewer registration. Actor and Item are initial supported categories;
   availability is explicit, not inferred from the presence of an actor sheet.
2. Core derives the exact canonical compendium UUID from the authorized target.
   Never resolve by name, take the copied world's ID as the compendium ID, or
   silently choose same-name content from another source. An Actor with no exact
   origin has no link. Native origin and verified Core copy origins must both work.
3. Declaration alone does not establish availability. A caller-bound read/eligibility
   path verifies source access/existence and module support before exposing the
   link, and checks again when opening/settling the request. Browser rendering is
   never the authority for access. Installation or service-account hydration is
   not permission for the requesting user.
4. The viewer receives a typed reference context and an authorized reference model
   or obtains it through a public caller-bound read contract. Resolve the data from
   the compendium source; the encounter reference only establishes navigation.
   Exported signatures are in `shared/sdk/referenceViews.ts`; the server hook
   prepares JSON and the UI manifest registers lazy content per document type.
5. The module supplies its informational content, with Core controlling a shared
   accessible host dialog. Preserve module styling, mobile layout, scroll bounds,
   focus restoration, Escape and nested reference-view behavior if supported.
6. Load on demand. Availability/read failure must not block combat readiness or
   bootstrap, mutate source data, create a parallel world cache, or require a
   native Foundry browser. Coalesce equivalent reads using existing contracts.
7. Retire pending and mounted content on world, caller, permission, connection,
   source, provider or selected-target changes. A late response cannot reopen a
   retired card. Other installed sources cannot supply a guessed replacement.
8. Older hosts/modules remain usable without the extension. Authoring docs must
   distinguish declared support, per-reference availability and mounted consumers.
   Do not advertise a contract version or capability before implementation.

## Trust and safety

This uses the existing trusted SheetDelver-module execution model. Module UI
already runs in the client for sheets/tools; SurfaceHost and an error boundary
are not a JavaScript security sandbox. The new extension grants no extra authority
and must never evaluate arbitrary uploaded/native package UI. Server authorization
remains mandatory. A read-only presentation contract means compliant viewers have
no actions or writes; it does not claim hostile module code is isolated. Use normal
rich-text sanitization, approved asset handling and caller-aware projections.

## Work packages and acceptance

| ID | Work | Completion evidence |
| --- | --- | --- |
| RVW-01 | Define optional typed Actor/Item viewer declaration, eligibility and reference context; document exports/version compatibility | An opted-out module and an older host work unchanged; Actor-only and Item-only providers resolve independently |
| RVW-02 | Exact source routing and caller-bound availability/read checks | Native imports and actual encounter copies resolve; unknown/malformed origins, missing documents and inaccessible sources expose no link; no name-based substitution |
| RVW-03 | Combat manager link and shared viewer host | Supported accessible source opens on keyboard/mouse; normal row selection and controls remain intact; omitted/declined/error cases do not break combat |
| RVW-04 | Shadowdark informational bestiary-card adoption | Original compendium data displayed even when encounter HP/effects differ; established styling retained; no combat/write actions; existing copies work after restart |
| RVW-05 | Lifecycle, packaging and developer coverage | Revoke/restore, world/user/source/provider changes, late responses and reconnect retire correctly; installed development/production packages and responsive accessibility checks pass |

Use independent original-source fixtures and compare the displayed reference with
that source. Deliberately alter encounter-instance HP/effects and prove they do
not replace reference fields. Test actual public Compendium-copy creation and
pre-existing copies, not just world Actors hand-seeded with native origin fields.
Verify Actor and Item contracts with fixture providers, while adding no speculative
Item consumer to the product. Record zero viewer-triggered source writes, including
open/close/retry. Test unsupported modules with no misleading link, restricted GM
or Assistant source access, module failure, missing artwork and stale async replies.

Update SDK authoring, manifest, architecture and API documentation with actual
signatures when implemented; keep module-specific implementation/docs module-owned.
Do not mark this ADR complete from interface declarations or isolated mocks alone.

## Scope history and exclusions

The user explicitly clarified that this is the bestiary/reference presentation,
not live stats or action controls, and agreed that unsupported modules should show
no link. This selects the informational-reference subset of deferred DW-13.
DW-08's live combat cards, action bars, resource controls and rule execution remain
deferred. Item-consuming Core UI, encounter spawning/sharing, marketplace/content
imports and arbitrary Foundry-module/browser-hook compatibility remain outside scope.

ADR-0067's artwork implementation is checkpointed independently (Core `e41c4b48`,
Shadowdark `defb07b` / `6d190d1`). This ADR does not reopen that completed feature or amend migration ADR-0064.
The following implementation record supersedes the initial planning-only status.


## Implementation and verification record — 2026-10-21

The user authorized implementation after agreeing the informational-only scope.
Core remains on `feat/sdk-foundry-package-context`, base `e41c4b48`; Shadowdark
remains on `fix/restore-module-presentation`, base `6d190d1`. This slice is
uncommitted. No push, release, native world mutation or version change occurred.
SDK3.5.0/module-api1.7.0/UI3.3.0 are the existing unreleased ADR-0067 additions;
this compatible additive slice shares that pending version set. Shadowdark's
optional structural adoption keeps its existing compatibility declarations.

### Executable contract

- `src/shared/sdk/referenceViews.ts` exports identity/context/runtime/model/viewer
  types. `SystemAdapter.prepareReferenceView` is the optional server projection;
  `UIModuleManifest.referenceViews` declares Actor/Item lazy UI and dialog classes.
- `registerCompendiumReferenceRoutes` accepts an exact typed UUID or authorized
  manager combat/participant. The existing `readDisplayArtworkContext` and
  `readCombatCopySourceUuid` supply caller-authorized target/provenance reads.
  Native imported origins are supported; no same-name replacement is attempted.
- `CompendiumReferenceService.prepareCompendiumReference` supplies frozen original
  source data and a read-only runtime, bounds reads/module work, and rereads source
  before delivery. Caller/world/target/package revision and native pack type are
  checked; unauthorized/missing/declined/error results expose no link/model.
- `CompendiumReferenceLink` uses the active registered provider, fresh reads on
  opening, a loading deadline, and generation/abort guards. It retires stale
  content on relevant signals instead of retaining private data. Shared
  `SurfaceHost`, `RollDialogFrame` and `useModalFocus` provide the sole host shell.
  Modules render content only; load/render errors preserve a usable Close control.
- Shadowdark's `server/reference-view.ts` and
  `ui/components/CompendiumReferenceView.tsx` use the existing NPC/Item card models.
  Extracted `ResourceCardBody` preserves established interactive cards; reference
  mode renders enriched action/link labels as sanitized informational text.
  `module/ui.tsx` registers both categories; only Actor links are consumed in Core.

### Acceptance results

| Requirement | Verified result |
| --- | --- |
| RVW-01 | Public optional types, older-host structural adoption, separate Actor/Item routing and model preparation; no provider creates no link |
| RVW-02 | Exact source/native origin and actual public encounter copy routing; malformed/embedded/wrong-type/missing/denied inputs declined; unchanged copies resolve after Core restart |
| RVW-03 | Actual manager links open an accessible shared dialog; Escape returns focus; unsupported/revoked links disappear; ordinary participant controls remain intact |
| RVW-04 | Installed Shadowdark card preserves art/title/fades; displayed facts equal original native fixture even after copy HP/max is changed to1; only host Close button, no viewer writes |
| RVW-05 | Unit permission/source races and deadlines; mounted caller/world/selection/disconnect/provider/load/render failure checks; installed development and production managed package checks at360/1440px with real ownership-setting revoke/restore |

Core maintained unit/client/integration suites passed. New source-contract suite
has9 groups, mounted consumer coverage has14 requests, and all19 maintained
Shadowdark suites passed. Explicit Core and module source typing, changed Core
lint, isolated module checking/packaging and whitespace checks passed. Each real
host run completes12 checks (existing artwork regression plus reference acceptance).
These are isolated real Core/Next hosts with controlled upstream native4.0.6 data,
not new native Foundry/operator acceptance. The harness imports installed community
art files read-only; no operator services or world documents are changed.

Reproduction (from Core, development browser paths supplied by the environment):

```text
npm run test:unit
npm run test:client
npm run test:integration
npx tsc --noEmit
node src/tests/acceptance/compendium-reference.browser.mjs
npx tsx data/local/modules/shadowdark/src/tests/reference-view.test.ts
npm run module:package -- shadowdark --data-dir <isolated-data>
npx tsx data/local/modules/shadowdark/src/tests/installed-consumers.core.ts --run-isolated --archive=<archive> --out=<fresh-output> --generation=14 --production --artwork-only --reference-views --community-art-root=<read-only-installed-package>
```

Set `PLAYWRIGHT_MODULE`/`CHROME` for the Core browser harness and
`SHADOWDARK_PLAYWRIGHT_MODULE`/`SHADOWDARK_CHROME` for installed acceptance. Omit
`--production` for the development-host case. Explicit module typing includes
`module/**/*`, `src/**/*`, migrations and Core's `next-env.d.ts`, extending Core's
tsconfig; Core's ordinary root type check alone does not cover local module source.
The module CI workflow includes `reference-view.test.ts` on its unchanged Core pin.

Archive SHA-256:
`43ede0a724e5c15fcefa524e1b6fc447d9f7156c2e25876d7314e848ad7891b1`.
Local acceptance outputs: `/tmp/reference-view-development`,
`/tmp/reference-view-production` and final `/tmp/reference-view-production-final`.
The archive is `/tmp/reference-view-package/data/dist/modules/shadowdark-0.9.6.tgz`.
These paths are convenient local outputs; this tracked record and maintained
harnesses contain the acceptance contract without requiring ignored reports.

Operator review and commit/release are separate next steps. Broad live resource
cards/actions and Item-consuming Core product surfaces remain deferred. Optional
hooks run in the existing trusted module model; no sandbox guarantee is claimed.

Final production tested Core source-tree SHA-256:
`ffa636bab7615c17dc31c24a9d391e1ab960657d8ad973f2acb22a21c19c4f9e`.
Subsequent edits only update documentation and reposition an SDK method comment.
All task-owned services stopped after acceptance; operator services were untouched.


### Operator follow-up: compact combat rows

The user confirmed the reference feature and reported a roster layout regression
when adding a hidden, unrolled participant after combat had started. The reference
link and single-line action group could squeeze the name and HP/AC pills.
At the user's request, `CombatManagerPage` now separates the identity block from
an explicit three-column, two-row action grid. Name, whole stat pills and status
labels have separate lines; source subtext (`world link`/`pack copy`) is removed
from roster rows. Narrow layouts move the controls below identity. The reference
link remains outside the selection button. No action/permission logic changes.
The user accepted this presentation trial and authorized checkpoint commits.

Targeted verification passed: a second copied participant was added after combat
started, then made hidden/unrolled. At360/820/1440px all six controls occupy two
rows, HP/AC pills remain whole, the Damage icon retains its width, and the row has
no horizontal overflow or source subtext. Isolated development host run12/12;
Core typing, changed-file lint, explicit harness typing and whitespace passed.
Screenshots inspected at `/tmp/reference-roster-layout-reviewed/shots/`.
The harness's `--roster-layout` fixture uses6 native setup writes (two copies);
presentation writes remain0. Test services stopped; operator services unchanged.


### Accepted checkpoint

The user confirmed the reference feature and the revised combat rows, then
explicitly authorized local Core and Shadowdark checkpoint commits. This records
operator-reported acceptance in addition to the isolated verification above.
Further combat-manager UI cleanup is the next selected area, with specific edits
to be agreed before final closeout. No push, merge, tag or release is authorized
by this checkpoint; application and compatibility versions remain unchanged.
