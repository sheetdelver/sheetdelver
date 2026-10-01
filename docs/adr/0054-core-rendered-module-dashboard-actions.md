# ADR-0054: Core-Rendered Module Dashboard Actions

**Status:** Closed; verified
**Date:** September 29, 2026
**Closed:** September 30, 2026
**Related:** ADR-0027, ADR-0044, ADR-0053

## Context

The dashboard is a Core page with a browser-local dark/light appearance, but
its module tool area is currently an arbitrary `dashboardTools` React
component. `DashboardView` passes module colors, a token, and Core loading
setters to `SystemTools`, which mounts that component under a module style
scope. The checked-out Shadowdark and Mörk Borg modules draw fixed black
dashboard panels and white-text buttons; both register a generator route,
and Shadowdark also opens an importer dialog. D&D 5e has no dashboard tool
component. This is a pre-extraction integration relic, not a reason for
modules to own dashboard appearance. Module-authored sheets, full tool pages,
and importer dialogs remain module-owned surfaces.

The UI manifest already declares lazy `tools` page entries, but it cannot
describe dashboard actions. `dashboardTools` and `dashboardLoading` are typed
loosely. Core cannot
recolor their inner markup without a broad CSS override that would violate
ADR-0053's module theme boundary. An importer dialog cannot be represented by
a route-only card. Dashboard visibility is not authorization; module APIs and
Core routes continue to enforce the acting user's permissions.

## Decision

1. Add an optional, typed `dashboardActions` array to `UIModuleManifest` and
   export its types from `@sheet-delver/sdk`. Each action has a stable bounded
   ID, display label, and optional description. Its target is one of:
   - `kind: 'tool'` with a `toolId` declared in the same manifest's `tools`
     map. Core constructs `/tools/:systemId/:toolId` and renders the link.
   - `kind: 'dialog'` with a lazy module component accepting `onClose`. Core
     owns the launcher/open state, but the dialog's content and behavior stay
     module-owned. Dialogs mount only when opened under `SurfaceHost` so the
     SDK context, error boundary, loading fallback, and module CSS scope work.
2. `SystemTools` validates and bounds the client manifest entries, then renders
   a Core-owned section, cards, typography, focus states, and active
   dark/light colors using the existing `sd-ui-*` palette. Module CSS scope
   must not wrap those cards; it wraps only a loaded module dialog. No arbitrary
   URL, JSX fragment, module theme class, token, or host loading setter is part
   of the new action contract. The action label/description are module content,
   not presentation authority.
3. Remove `dashboardTools`, `dashboardLoading`, and their private Core props
   from the UI contract and host. A module with no `dashboardActions` has no
   module dashboard cards. There is no compatibility renderer or CSS shim;
   current modules are controlled migration targets. `theme` and
   `componentStyles` remain available for module-owned pages/sheets and
   explicit SDK component overrides, not for dashboard chrome.
4. The host rejects malformed or excessive action entries and never invents a
   route for an undeclared tool ID. This is UI validation, not an authorization
   grant. Core's authenticated tool route and module APIs keep their existing
   guards. Source and managed UI manifests use the same contract.
5. This breaks the previous client presentation contract: increase
   `SDK_VERSION` from 1.5.0 to 2.0.0 and `ui-extension-api` from 1.3.0 to
   2.0.0. Leave
   `module-api` and `roll-engine-api` unchanged. Update SDK/module authoring
   references and tests without creating a second version authority.

## Migration and release sequence

First land the Core SDK/renderer and test the new action contract and removal
of the old path on this dedicated branch. The application release is prepared only after that
branch is reviewed and merged to `main`, using the documented main-only
release helper. The root package version is chosen for that release, not
changed merely to compile this feature branch. Remote publication remains a
separate coordinated operation.

After a host release exists, migrate each module in its own repository:
Shadowdark declares generator and importer actions, while Mörk Borg declares a
generator action. Remove their legacy dashboard components/loading wrappers
only in those module changes. Their generator pages, importer implementation,
sheets, and module theme objects are not recolored. Each migrated `info.json`
raises
`compatibility.apiContracts['ui-extension-api']` to `>=2.0.0 <3.0.0` and sets
`compatibility.coreVersion` to the released host minimum. Run module checks,
package checks, and local/managed UI acceptance before publishing the module
updates. D&D 5e has no dashboard actions, but its declared UI contract range
must still be updated before it can load against the released host.

Because Core is released before module updates, old module releases declaring
`ui-extension-api <2.0.0` become incompatible during that rollout interval.
The operator must coordinate host and module publication/installation; this
ADR does not disguise the gap with a legacy renderer.

Combat Manager work and its GM acceptance remain separate from this ADR. Its
GM tool card is Core-owned; this decision does not merge those branches.

## Verification requirements

- New action cards follow the Core palette in dark/light modes and do not
  receive a module theme prop or CSS scope. Tool cards navigate only to
  declared module tool IDs. Dialogs open/close under SDK context, preserve
  their module-owned content, and fail within `SurfaceHost` rather than taking
  down the dashboard.
- An absent or empty array renders no module actions. Old
  `dashboardTools`/`dashboardLoading` no longer enter the host; malformed
  entries do not create a navigation target or crash the dashboard. Action count, labels,
  IDs, and descriptions have bounds.
- SDK/public barrel, contract versions, authoring docs, module checker or
  fixture tests, local-source and packaged manifest paths, and branch-level
  TypeScript/lint/unit/build checks match the new contract. Rendering and
  packaged-module behavior require explicit acceptance rather than being
  inferred from source types alone.

## Verification and closure

Core v0.14.2 released the typed action contract, host validation and rendering,
dialog `SurfaceHost` boundary, and removal of the legacy dashboard component
path. `src/shared/sdk/contractVersions.ts` remains the sole authority for SDK
2.0.0 and `ui-extension-api` 2.0.0.
The module scaffold, authoring docs, compatibility tests, and dashboard action
tests cover the new shape, including malformed entries, absent actions, tool
routes, and Core palette classes. Lint, unit suites, type-checking, and an
isolated production build passed before the Core release.

Shadowdark v0.9, Mörk Borg v0.8, and D&D 5e v0.4 adopted the new UI contract
against Core v0.14.2 and passed their module CI and release packaging. The user
accepted the rendered Shadowdark and Mörk Borg dashboard appearance, including
Mörk Borg's corrected module-owned generator palette. D&D 5e declares no
dashboard action. The user also verified Shadowdark's importer after it moved
from a dashboard dialog to a module-owned tool page in v0.9.1. That follow-up
avoided an unsupported `react-dom` portal assumption in the packaged module;
the SDK dialog action remains available but is unused by these current modules.
Shadowdark v0.9.1 passed PR, main, and release CI and published its module
archive, checksum, and manifests. No Core compatibility shim was added.

The verified release and user acceptance close this dashboard contract rollout.
Further Combat Manager work is outside this ADR.

## Consequences

The dashboard becomes visually consistent without seizing module sheet/page
ownership. Older module releases are incompatible until migrated. Module
authors trade arbitrary dashboard markup for a narrow action declaration and
gain standard Core accessibility, layout, and theme behavior. The host owns
presentation; modules retain tool and dialog functionality.
