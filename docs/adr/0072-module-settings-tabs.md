# ADR-0072: Module tabs in the player configuration dialog

**Status:** Implemented — checkpointed; final operator review and supporting publication pending
**Date:** 2026-10-23

## Purpose and ownership

An installed system module supplies the presentation component for each of its
settings panels. It registers those components in its UI manifest. Core discovers
them and renders their tabs in the existing HUD configuration dialog. One module
can register multiple panels; no Core edit is needed to add another panel later.

| Responsibility | Owner |
| --- | --- |
| Modal, tab buttons, ordering, selection, scrolling, close/focus behavior | Core |
| Panel content, semantic fields, layout, validation and module-specific actions | Module |
| Panel typography, colors, controls, spacing defaults and focus states | Core |
| Lazy loading, SDK identity/context, errors and retry | Core SurfaceHost |
| Browser preferences | Existing public SDK settings store |
| Server-backed module settings/actions | Module APIs with their existing authorization |

The public integration is a **manifest declaration**, not a React `Tab` prop on
Core's configuration component. The registered lazy loader returns the module's
React panel; Core supplies the small lifecycle props specified below. Modules
never import PlayerSettingsDialog or construct a second modal/tab bar.

## Prior implementation extended

- `src/client/ui/components/Settings/PlayerSettingsDialog.tsx` owns fixed General
  (disabled), Chat & Rolls and Themes tabs. It already closes on session/world
  changes and owns native-dialog focus restoration.
- `src/shared/sdk/interfaces.ts` defines UIModuleManifest and
  ModuleSettingDeclaration, but no settings-panel extension.
- `src/client/ui/components/SurfaceHost.tsx` supplies the SDK provider, surface root, Suspense and error boundary. Settings use a Core-styled
  root instead of the module CSS scope. A `settingsTab` surface fits this existing
  wrapper; it must use an inline panel fallback rather than another modal.
- `src/shared/sdk/client-hooks.ts` exposes useModuleSettings with get/set/all,
  defaults and reactive browser storage scoped to world/module. It has no reset
  operation or schema validation. Same-browser accounts share this namespace.
  Native `worldSettings` is a separate read-only context contract.

## Public contract

Export these types from the public SDK and add `settingsTabs` to UIModuleManifest:

```ts
export interface ModuleSettingsTabProps {
    /** Aborted when this panel is deselected, closed, unloaded or loses its scope. */
    signal: AbortSignal;
    /** Report unsaved local form edits; false initially and after save/discard. */
    onDirtyChange: (dirty: boolean) => void;
}

export interface ModuleSettingsTab {
    id: string;
    label: string;
    audience?: 'all' | 'gm'; // default all; gm includes Assistants
    load: () => Promise<{ default: ComponentType<ModuleSettingsTabProps> }>;
}

// In UIModuleManifest:
settingsTabs?: ModuleSettingsTab[];
```

The props belong to the loaded **panel**, not its tab button. Core supplies no
credentials, private host objects, persistence callbacks or save-button styling.
The module uses public SDK hooks for its settings and any authenticated operations.
The signal is a lifecycle notification, not a claim that an already-dispatched
server write can be undone. Components must ignore aborted async completions and
must not start a new write after their panel has been retired.

### Module-side example

These exports/fields are implemented in SDK3.7/UI3.5; supporting Core publication
is pending. Panel components ship in the module package; their settings presentation comes from Core.

```tsx
// module/ui.tsx
import type { UIModuleManifest } from '@sheet-delver/sdk';

const ui: UIModuleManifest = {
    // Existing info, sheet, tools, etc.
    settingsTabs: [
        { id: 'sheet', label: 'Sheet', load: () => import('../src/ui/settings/SheetSettings') },
        { id: 'gm', label: 'GM Options', audience: 'gm',
          load: () => import('../src/ui/settings/GMSettings') },
    ],
};
```

```tsx
// src/ui/settings/SheetSettings.tsx
import type { ModuleSettingsTabProps } from '@sheet-delver/sdk';
import { useModuleSettings } from '@sheet-delver/sdk/react';
import info from '../../../info.json';

export default function SheetSettings({ signal }: ModuleSettingsTabProps) {
    const settings = useModuleSettings(info.settings);
    return <section>
        <h3>Sheet display</h3>
        <p>Changes save immediately in this browser for this world.</p>
        <label>
            <input type="checkbox" checked={settings.get<boolean>('compactInventory', false)}
                onChange={event => {
                    if (!signal.aborted) settings.set('compactInventory', event.target.checked);
                }} />
            Compact inventory
        </label>
    </section>;
}
```

The example assumes `compactInventory` is declared as a boolean setting in
info.json and consumed by the module sheet. Registering a tab does not implement
the setting's effect. Production panels must display SDK storage/validation
errors through the shared notification or inline-error components. See the
[complete implemented authoring example](../MODULE_MANIFEST.md#settings-tabs-sdk-370--ui-350).

## Host resolution and rendering

1. Resolve only the selected system's UI manifest through getUIModule. Accept at
   most eight tabs; reject invalid entries independently. IDs are 1–64 lowercase
   letters/digits/underscores/hyphens starting with a letter. Labels are trimmed,
   nonempty and at most80 characters. Require a loader function, unique ID and
   valid audience. Log bounded diagnostics without rendering malformed tabs.
2. Keep Core tabs first, followed by eligible module tabs in manifest order.
   Namespace tab identity as module ID + tab ID so modules cannot replace Core
   tabs. Show a module-title caption only for multiple tabs. A single tab uses
   its recognizable module name; keep the accessible group label in both cases. Audience `gm` uses the existing role>=3 convention.
   It governs visibility only; API operations retain server authorization.
3. Render a horizontally scrollable tab strip with Core styling and consistent
   selected/focus states. Keep labels readable at320px. Use roving tabIndex,
   arrows and Home/End to move focus; Enter/Space selects and loads a panel.
   Tab moves into the active panel. Give each tab and panel matching ARIA IDs.
4. Lazy-load only the selected panel. Mount it under
   `<SurfaceHost moduleId={id} surface="settingsTab">`, keyed by world, module,
   tab and retry generation. Settings keep SDK identity but omit the module CSS
   scope and use Core semantic-control styling. Use an inline loading message
   and inline error with Retry; a rejected import or crashed panel must leave Core tabs/close usable.
   Retry creates a fresh lazy component and error boundary. Do not wrap the
   Core tab strip/header/footer in module CSS scope.
5. Keep only the selected module panel mounted. Abort its signal before unmount;
   ignore stale imports and dirty notifications. Close/unmount on logout,
   world/module change or module unload. Role demotion removes an ineligible
   panel and selects Chat & Rolls. Forced scope changes discard local drafts
   without saving or replaying server requests.

Installed module components use the existing module trust model; SurfaceHost is
an error/style/context boundary, not a sandbox for untrusted code.

## Save, close and reset behavior

**Immediate preferences:** useModuleSettings remains the normal get/set/all path.
A successful write updates all consumers in the same namespace; panels label the
behavior as immediate save. Done closes the dialog; it is not a global Save action.

**Staged forms:** the panel owns its Save/Discard buttons, validation and pending
request state. Call onDirtyChange(true) after a draft edit, false after confirmed
save or explicit discard. Core intercepts ordinary tab switches, Done, Close and
Escape when dirty, using the shared confirmation component. Continue editing
keeps the panel mounted; Discard proceeds with the requested navigation. No
host-side automatic Save callback is added. A failed save keeps the draft dirty.
Confirmation must be tested above the native dialog's top layer with correct
focus, not rendered invisibly behind it. Forced lifecycle changes follow step5.

**Browser store:** retain the existing world/module namespace and migration-free
fallback to defaults. Add `reset(keys?: readonly string[]): void` to the public
ModuleSettings controller. Omitted keys means only the provided schema's declared
keys; explicit keys must also belong to that schema. Refuse reset without a
schema. Remove stored overrides, notify consumers and expose defaults again;
preserve undeclared keys and all other namespaces. Modules choose whether to show
a per-panel reset control and which declared keys it affects. Core does not add
a misleading reset-all button for server-backed/custom forms.

Validate schema-backed writes against boolean/string/finite-number/select types
and allowed select values. Optional bounds can be added to setting declarations
where needed, while omitted bounds preserve current behavior. Preserve the
existing schema-less get/set use case; do not retroactively reject undeclared
legacy settings for unrelated module consumers. Stored invalid overrides fall
back to declared defaults without silently rewriting storage. On read/write/reset
storage failure, surface an error; do not report successful persistence or update
the reactive snapshot as if the write succeeded. A reset touching multiple keys
must publish the actual remaining values if storage fails partway through.

Server-backed module settings continue through the module's SDK/API path. This
extension introduces no native Foundry Setting writer, synced-user storage or
permission bypass. Their persistence/errors remain the module's responsibility.

## Implementation work packages and completion criteria

### MS-01 — Contract and registration resolver

- Add/export the two interfaces and optional manifest array in interfaces.ts and
  SDK entry points. Implement a pure `settingsTabs.ts` resolver beside the host
  Settings components, sharing the established bounded-validation pattern.
- Extend SDK integrity/type fixtures; test absent/empty tabs, eight-tab limit,
  duplicate/invalid IDs, labels, loaders, audiences and declaration order.
- Complete when old manifests remain valid and malformed contributions cannot
  suppress the usable Core tabs. The additive implementation uses
  SDK3.7/UI3.5; other named contracts are unchanged.

### MS-02 — Dynamic modal host and lifecycle

- Extract Core tab definitions/panels from PlayerSettingsDialog; replace its
  hardcoded union/index/grid with stable IDs and the accessible tab strip.
- Add selected-module manifest resolution, role filtering, lazy SurfaceHost
  mounting, abort lifecycle, inline retry and focus restoration.
- Complete when real mounted tests cover zero/one/two module tabs, only-selected
  loading, module/world changes, role demotion, stale loads, panel errors/retry,
  keyboard traversal and320px layout. Existing Chat & Rolls/Themes still work.

### MS-03 — Draft protection and settings persistence

- Wire onDirtyChange and a single guarded navigation path for ordinary tab/close
  actions. Verify nested confirmation placement in the native dialog top layer.
- Extend the SDK settings controller with schema-backed validation and reset,
  correct storage-failure publication and scoped reactive updates. Keep existing
  persistence keys and schema-less callers compatible.
- Complete when tests cover successful/failed saves, continued editing, discard,
  forced unmount, reset/defaults, unknown-key preservation, denied/partial storage
  and isolation between world/module namespaces. Aborted panels cannot update
  the host's dirty state; module examples demonstrate async signal handling.

### MS-04 — Real module pilot and packaging

- Select one existing module preference for the first adoption; do not invent a
  setting purely to populate a tab. Add its panel file and registration in that
  module repository; use semantic controls styled by Core. A controlled fixture
  supplies the second tab and GM-only coverage if the module needs only one real panel.
- Verify the real preference changes its consumer, survives reopening/reload,
  resets correctly and uses the intended browser/world/module scope. Verify lazy
  panel initialization and CSS in a packaged module, not just a local source
  checkout (the single-bundle packaging decision below resolves chunk behavior).
- Complete after dark/light Core chrome, Core-styled module controls, narrow widths,
  keyboard and operator checks. Module approval/release stays module-owned.

### MS-05 — Documentation and release readiness

- Replace proposal examples with the implemented interfaces and a complete
  authoring example in MODULE_MANIFEST.md; document persistence, audience,
  dirty forms, abort/error handling, reset and older-host behavior in API.md and
  architecture.md. Add the final behavior to SDK compatibility tests/changelog.
- Publish the supporting Core release before a module requires the new contract.
  Older hosts omit unrecognized registrations; essential settings must retain
  an older entry point or declare the new UI minimum. Package versions/tags are
  changed only during separately authorized release preparation.
- Complete after checks above pass and operator review is recorded. Keep any
  unresolved acceptance item explicit instead of declaring proposal completion.

## Implementation decisions — October 23

- SDK3.7.0/UI3.5.0 identify the additive registration, props, validation/reset and
  shared confirmation `topLayer` option. Module API1.7/roll API1.0 and application
  version0.20.1 remain unchanged. Supporting Core publication remains pending.
- `CoreSettingsPanels` retains existing Chat & Rolls/Themes behavior and disabled
  General. `settingsTabs.ts` bounds registrations; module keys use
  `module:<systemId>:<tabId>`, separate from Core keys. `PlayerSettingsDialog`
  resolves the selected manifest via `getUIModule`; socket source/state/registry
  changes close settings. Session epoch/account/world/system/manifest changes
  retire the modal; role changes only retire an ineligible panel.
- Each committed `ModuleSettingsPanel` mount owns a fresh abort controller and
  private dirty flag. Ordinary navigation aborts before changing selection.
  Layout cleanup aborts forced retirement, and SurfaceHost's pre-update error
  hook aborts before a crash/import fallback unmounts content. Stale dirty
  reports become no-ops. StrictMode effect rehearsals receive fresh live signals;
  a child-only rehearsal cleanup is not a real scope retirement.
- Confirmation reuses `ConfirmationModal` with `topLayer: true`, which opens a
  second native modal via the existing body portal. Its Escape event does not
  close the parent. Continue editing receives initial focus; Core's shared focus containment
  and focus restoration work above the parent, independent of z-index. Legacy
  uses keep their existing overlay. Settings, confirmation and focus-hook scroll
  locks share ownership; the final release restores the original inline overflow
  and its priority, independent of nested teardown order (R72-01 below).
- `useModuleSettings` exposes `error: Error | null` for read/storage failures;
  set/reset also throw. Bounds are inclusive numeric `min`/`max` and string
  `minLength`/`maxLength`. JSON serialization must succeed before storage, and
  snapshots publish only persisted JSON values. Invalid JSON/typed overrides
  fall back without rewriting. Reset validates every requested key up front,
  publishes successful removals on partial failure, and preserves legacy keys.
  Storage events and remount reads refresh other consumers without new keys.
- The user approved the narrow Shadowdark pilot on its existing branch. Its
  Simple/Advanced sheet view already used `shadowdark_view_mode`, scoped to the
  whole browser/site. A module-owned reactive helper now shares that same key
  between the real sheet and optional settings panel. There is **no migration**
  into the SDK world/module store. Reset removes that key only. The existing
  sheet button remains an older-host entry point, so floors/workflow pins and
  module0.9.6 remain unchanged. Module-owned ADR0004 records adoption.
- **Packaged lazy-loading detail:** the existing packager emits one UI ESM
  bundle, folding dynamic imports into deferred initializers. MS-04's chunk
  inspection is resolved by checking and mounting the archived panel's lazy
  initializer plus packaged CSS; this change preserves the existing artifact
  format. It does not promise separate network chunks or change the UI serving
  routes. Local framework builds retain source dynamic imports. A multi-file
  managed ESM format would be separate tooling/compatibility work.

## R72-01 — Nested scroll-lock cleanup correction

Independent review reproduced a retained `body.style.overflow = 'hidden'` after
Done → Discard, or world change/logout with the confirmation open. Both dialogs
had disappeared. Settings, ConfirmationModal and useModalFocus each restored a
different saved overflow value; parent-first cleanup could restore the original
value and then overwrite it with the child's stale `hidden` snapshot.

`bodyScrollLock.ts` now coordinates these owners per body element. Only the first
acquisition saves inline overflow/priority. Each effect receives an idempotent
release; the last owner restores the saved value. Focus ordering remains with
useModalFocus and is independent of scroll ownership. Closing only the confirmation
keeps settings locked; forced parent/child retirement releases all ownership
without forcing an empty overflow value over an existing page policy.

The mounted acceptance runner first failed on the reported Done → Discard leak,
then passed with the correction. It checks empty, `scroll !important` and already
`hidden` originals; clean/discard close, world/logout/module/unload/root retirement
with confirmation open, Continue editing, discard-to-another-tab and reopening.
It verifies actual wheel scrolling resumes when allowed and that a pre-existing
lock remains. Legacy and top-layer ordinary confirmations retain their presentation,
Confirm/Cancel behavior and original overflow; native focus restoration and the
existing keyboard/top-layer suite also pass. The independent four-flow probe now
finishes each case with zero open dialogs and the original empty overflow.

R72-01 is corrected on isolated evidence. Operator review and publication remain
pending; this correction does not close the ADR or change public versions.

## Verification and remaining acceptance

| Package | Implemented evidence | Remaining |
| --- | --- | --- |
| MS-01 | Public types/export/type fixture; bounded resolver tests for old, empty, malformed, duplicate, over-limit and ordered contributions; compatibility checks for UI3.4 rejection/UI3.5 acceptance when required | Supporting release publication |
| MS-02 | Actual modal and SurfaceHost mounted under controlled providers; zero/one/two panels, lazy selection, stale loads, inline import/crash retry, role3 visibility/role2 retirement, world/module/logout/unload, ARIA/focus, keyboard and320px dark/light chrome | Operator review |
| MS-03 | Store fault-injection tests, mounted immediate/staged forms, failed/successful save, continue/discard/tab/Done/Close/Escape, late callbacks, abort-before-final-cleanup, top-layer visibility/keyboard focus, validation/defaults, denied/partial storage/reset and namespace isolation | Operator review |
| MS-04 | Approved Shadowdark source typing/module check/archive; archived ESM/CSS in the real host and real Actor page, two-way preference changes, reopening/reload, reset isolation, denied write, preserved world/account sharing, keyboard and320px dark/light styling (initial module theme superseded by R72-02) | Operator review |
| MS-05 | Manifest/API/authoring/architecture/changelog and compatibility fixtures updated; no application/module release bumps | Publish supporting Core first; operator acceptance before closeout |

Reproducible Core checks: `npm run test:client`,
`npx tsx src/tests/unit/sdk/sdk-integrity.test.ts`, `npx tsc --noEmit`,
`npx tsx src/tests/unit/modules/module-compatibility-resolver.test.ts`, and
`npx tsx src/tests/unit/docs/adr-metadata.test.ts`. The mounted fixture is
`src/tests/acceptance/module-settings.browser.mjs`; set `PLAYWRIGHT_MODULE` to an
external Playwright installation and `CHROME` when needed. Browser tooling is
not an application dependency. The module owns its archived pilot runner,
`src/tests/settings-panel.browser.mjs --archive=<tgz>`, invoked from a configured
Core checkout with the same environment and `node --import tsx`.

These are isolated fixtures, not live Foundry/native acceptance. No production
Core service or Foundry probe/write was started. Operator acceptance and supporting
Core publication remain outstanding; this ADR is **not closed**. Dice timing
remains unrelated and excluded. Release preparation/publication is separate.

## R72-02 — Core presentation for settings content

Operator review rejected the paper-themed module panel inside Core Settings.
This supersedes the earlier module-themed panel decision. Modules still ship the
panel component and own content, layout and behavior. Core supplies the complete
settings presentation automatically, including heading/body typography, form
controls, buttons, disabled states, focus and dark/light colors.

SurfaceHost retains SDK module identity and lifecycle/error boundaries for
`settingsTab`, but mounts `.sd-settings-content` without `.sdk-module--<id>`.
Core's semantic selectors style headings, paragraphs, labels, inputs, selects,
textareas and buttons using the existing player palette/control rules. Authors
need no host imports or styling props. Layout utilities are allowed; module theme
providers, paper wrappers, brand fonts/colors and theme-specific control classes
must not be applied to settings panels. Other module surfaces keep their styles.
This is a presentation contract, not a sandbox against deliberately inline-styled
installed code.

A module with one tab should use its recognizable module name (Shadowdark in the
pilot). Core omits the redundant group caption for one tab, retaining an accessible
group name; multiple tabs retain the module title caption and descriptive labels.
The stable tab ID and all preference scope/save/reset behavior remain unchanged.
SDK3.7/UI3.5 are still unpublished, so this corrects that same delivery contract.

## R72-03 — Reuse loaded settings panels

Operator review identified repeat loading on each module-tab visit. Core now
caches React lazy component definitions by the registration's loader identity.
Pending loads are shared; successful definitions survive tab switches and closing
and reopening Settings. The first visit remains lazy. The cache contains no form
state, preferences, SDK context or mount session: each opening receives fresh
state and an AbortSignal, and existing dirty/discard protections still apply.

Failed imports are evicted; explicit Retry also evicts the selected definition
before creating a fresh error boundary. An obsolete rejection cannot evict a newer
entry. World/account/session/module identity changes and relevant module source,
state or registry notifications clear the cache while retiring the open dialog.
A different loader identity naturally receives its own entry. Weak keys avoid
retaining retired loaders. No SDK API or contract/release version changes.

The mounted regression first failed on the repeated loader call, then verifies
one load across tab/dialog revisits, no warm loading fallback, fresh signals and
form state, pending-load reuse, retry, and invalidation on scope retirement.

## Checkpoint — October 23

The user requested the implementation checkpoint after the Core-theme and caching
corrections. This checkpoint includes the SDK contract, Shadowdark pilot,
scroll-lock fix, automatic Core presentation and reusable lazy panel definitions.
The mounted regression suite (including scroll/focus), client tests, typing, lint,
SDK/compatibility checks, ADR metadata and packaged pilot evidence are recorded
above. No application/module release version or compatibility floor is changed.
Final operator review remains distinct from these isolated checks; supporting
Core publication is required before relying on the new settings contract.
