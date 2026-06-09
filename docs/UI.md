# UI Documentation

Sheet Delver's UI is a Next.js and React shell over the Core Service. The
browser does not talk to Foundry directly; it reads and mutates through the
Sheet Delver API, receives Socket.io invalidation events, and renders
system-specific surfaces through the module SDK.

---

## Application Shell

The first screen is the usable player/admin experience, not a marketing page.
The main browser shell owns:

- Authentication and connection state.
- World readiness/status display.
- Actor selection and actor-page routing.
- Journals and shared content.
- Global chat, dice UI, and combat overlays.
- Module UI mounting, error boundaries, style scoping, and SDK context injection.

Reusable host components remain host-owned. Module UI consumes them through
`useSDKComponents()` from `@sheet-delver/sdk/react`; module code must not import
host component files directly.

---

## State Model

The UI state is split into focused providers and hooks:

| Area | Responsibility |
|---|---|
| Auth/status | Login, current user, world status, connection readiness. |
| Documents | Host-owned document cache consumed by SDK hooks such as `useDocument()` and `useActorSheet()`. |
| Journals | Journal/folder browsing, pagination, and shared journal content. |
| Chat | Chat message cache, dice tray state, and message submission. |
| Combat | Active combat visibility, turn/round refresh, and combat HUD data. |
| Module SDK | `SDKProvider`, injected SDK context, module event bus, and host component context. |

Module UI should prefer SDK hooks over direct REST calls when a hook exists. The
host cache deduplicates reads, refreshes on realtime invalidation, and keeps
permission checks centralized in server routes.

---

## Module UI Loading

The browser resolves a module UI manifest with `getUIModule(systemId)`.

1. `GET /api/registry/sources` returns the active source for each module id.
2. Local dev source (`"local"`) loads through the generated
   `.managed/module-ui-registry.ts`, which contains explicit imports for modules
   under `<DATA_DIR>/local/modules`.
3. Managed artifact source (`"managed"`) loads through `GET /api/modules/:id/ui`.
   The server serves the compiled ESM artifact from `<DATA_DIR>/modules` and
   rewrites bare SDK/React imports to host-provided browser globals.
4. If a module cannot be resolved or throws during import/evaluation, the host
   falls back to the generic actor page/sheet and records the failure for
   lifecycle/admin visibility.

Managed artifacts are intentionally not bundled into the Next build. A stale or
broken installed artifact can fail at runtime without breaking `next dev` or
`next build`.

---

## Module Surface Hosting

Every dynamic module surface is mounted inside `SurfaceHost`.

`SurfaceHost` provides:

- A module-scoped root class, `.sdk-module--<id>`, for CSS isolation.
- Loading and error boundaries.
- Injection of SDK context and host component context.
- Best-effort runtime failure reporting when a module surface cannot render.

Module UI should use:

```tsx
import {
    useSDK,
    useSDKComponents,
    useActorSheet,
    useDocument,
    useDocumentMutation,
} from '@sheet-delver/sdk/react';
```

Use `useSDK().logger` instead of `console.*`, `useSDK().assetUrl()` for module
static assets, and `useSDK().resolveImageUrl()` for Foundry-relative image paths.

---

## Realtime Events

Raw Socket.io events are host implementation details. The app listens to
document-specific socket events from `AppSocketGateway`, then maps them into the
module-facing SDK signal bus.

Important raw event families:

| Event family | Purpose |
|---|---|
| `systemStatus` | Connection, world, auth, and readiness status. |
| `<type>Changed` | One document changed, e.g. actor, item, combat, journal, chat message, roll table, macro, playlist, or cards. |
| `<type>ListInvalidated` | A document list should be refreshed. |
| `sharedContentUpdate` | GM-shared image or journal content changed. |
| `moduleSourceChanged` / `moduleStateChanged` / `moduleRegistryChanged` | Module source/lifecycle changes that require UI manifest cache invalidation. |

Module UI receives the stable SDK signals instead:

| SDK signal | Payload |
|---|---|
| `document:changed` | `{ type, id, action }` |
| `document:listInvalidated` | `{ type, reason }` |
| `content:shared` | `{ kind, data }` |
| `connection:changed` | `{ connected, worldId }` |
| `world:ready` / `world:teardown` | `{ worldId }` |
| `module:initialized` / `module:disposed` | `{ moduleId }` |

Module components should treat realtime as invalidation. Refetch through SDK
hooks or host APIs instead of applying socket payloads as authoritative document
diffs.

---

## Styling

The host ships the global Tailwind reset and design tokens. Module styles compose
under the `SurfaceHost` root:

- Local dev modules can use Tailwind classes directly; the host build scans
  `<DATA_DIR>/local/modules`.
- Managed artifacts ship compiled scoped Tailwind output when the module has
  `src/styles/tailwind.css`.
- Static module stylesheets live under the module `assets/` directory and load
  through the module asset route.

Module CSS must scope selectors under `.sdk-module--<id>` unless the checker
explicitly allows the construct, such as `@font-face` or `@keyframes`.
