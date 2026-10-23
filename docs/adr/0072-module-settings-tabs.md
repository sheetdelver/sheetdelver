# ADR-0072: Module tabs in the player configuration dialog

**Status:** Proposed — implementation plan ready for review; runtime not implemented
**Date:** 2026-10-23

## Purpose and ownership

An installed system module supplies the presentation component for each of its
settings panels. It registers those components in its UI manifest. Core discovers
them and renders their tabs in the existing HUD configuration dialog. One module
can register multiple panels; no Core edit is needed to add another panel later.

| Responsibility | Owner |
| --- | --- |
| Modal, tab buttons, ordering, selection, scrolling, close/focus behavior | Core |
| Panel headings, fields, layout, descriptions, validation and module-specific actions | Module |
| Lazy loading, SDK context, module CSS scope, errors and retry | Core SurfaceHost |
| Browser preferences | Existing public SDK settings store |
| Server-backed module settings/actions | Module APIs with their existing authorization |

The public integration is a **manifest declaration**, not a React `Tab` prop on
Core's configuration component. The registered lazy loader returns the module's
React panel; Core supplies the small lifecycle props specified below. Modules
never import PlayerSettingsDialog or construct a second modal/tab bar.

## Existing implementation to extend

- `src/client/ui/components/Settings/PlayerSettingsDialog.tsx` owns fixed General
  (disabled), Chat & Rolls and Themes tabs. It already closes on session/world
  changes and owns native-dialog focus restoration.
- `src/shared/sdk/interfaces.ts` defines UIModuleManifest and
  ModuleSettingDeclaration, but no settings-panel extension.
- `src/client/ui/components/SurfaceHost.tsx` supplies the SDK provider, module CSS
  root, Suspense and error boundary. A `settingsTab` surface fits this existing
  wrapper; it must use an inline panel fallback rather than another modal.
- `src/shared/sdk/client-hooks.ts` exposes useModuleSettings with get/set/all,
  defaults and reactive browser storage scoped to world/module. It has no reset
  operation or schema validation. Same-browser accounts share this namespace.
  Native `worldSettings` is a separate read-only context contract.

## Public contract to implement

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

This is the intended integration after implementation; these exports/fields are
not available yet. Both panels and their styles ship in the module package.

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
errors through the shared notification or inline-error components.

## Host resolution and rendering

1. Resolve only the selected system's UI manifest through getUIModule. Accept at
   most eight tabs; reject invalid entries independently. IDs are 1–64 lowercase
   letters/digits/underscores/hyphens starting with a letter. Labels are trimmed,
   nonempty and at most80 characters. Require a loader function, unique ID and
   valid audience. Log bounded diagnostics without rendering malformed tabs.
2. Keep Core tabs first, followed by eligible module tabs in manifest order.
   Namespace tab identity as module ID + tab ID so modules cannot replace Core
   tabs. Display the module title as a group label; do not force a prefix into
   every short tab label. Audience `gm` uses the existing role>=3 convention.
   It governs visibility only; API operations retain server authorization.
3. Render a horizontally scrollable tab strip with Core styling and consistent
   selected/focus states. Keep labels readable at320px. Use roving tabIndex,
   arrows and Home/End to move focus; Enter/Space selects and loads a panel.
   Tab moves into the active panel. Give each tab and panel matching ARIA IDs.
4. Lazy-load only the selected panel. Mount it under
   `<SurfaceHost moduleId={id} surface="settingsTab">`, keyed by world, module,
   tab and retry generation. Use an inline loading message and inline error with
   Retry; a rejected import or crashed panel must leave Core tabs/close usable.
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
  suppress the usable Core tabs. Version the additive UI contract at delivery;
  no API version is reserved by this proposal.

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
  setting purely to populate a tab. Add its panel file, registration and scoped
  styling in that module repository. A controlled fixture supplies the second
  tab and GM-only coverage if the module needs only one real panel.
- Verify the real preference changes its consumer, survives reopening/reload,
  resets correctly and uses the intended browser/world/module scope. Verify lazy
  panel chunks and CSS in a packaged module, not just a local source checkout.
- Complete after dark/light Core chrome, module panel styling, narrow widths,
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

## Current disposition

This is an actionable plan for the module-settings portion of DW-19. No runtime
registration, component props or reset API described here has shipped. The next
implementation step is MS-01 followed by MS-02/MS-03, then the selected module
pilot and release documentation. Implementation authorization is separate from
this design revision.
