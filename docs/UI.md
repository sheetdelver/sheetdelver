# UI Documentation

SheetDelver's UI is built with **Next.js**, **React**, and **Tailwind CSS**, following a "Foundry-Modern" aesthetic: dark, high-contrast, with cinematic typography (Cinzel/Inter) and rich glassmorphism.

## Core Interaction Model

The UI is driven by a hierarchy of React Contexts that synchronize state with the Backend API:
- **`FoundryContext`**: Manages authentication, world status, real-time WebSocket synchronization, actor updates, and the active module UI manifest. Implements a state machine (`init`, `setup`, `login`, `authenticating`, `dashboard`) for smooth transitions. Also handles the `moduleSourceChanged` socket event — see [Real-time Events](#real-time-socket-events) below.
- **`JournalProvider`**: Manages journal entry loading, folder hierarchies, pagination (v13 standard), and GM-shared content.
- **`UIContext`**: Controls global visibility of sidebars, modals, and the Floating HUD.

---

## Key Components

### 1. Floating HUD (`src/client/ui/components/FloatingHUD.tsx`)
A permanent, stylish navigation bar anchored to the bottom of the screen. It provides quick access to:
- **Character Select**: Switch between owned and observable actors.
- **Journal Browser**: Browse world journals and folders.
- **Global Chat**: Access integrated chat and dice rolls.
- **User List**: Monitor active players and GM presence.

### 2. Journal Browser & Modal
- **JournalBrowser**: A folder-aware explorer for all visible journals.
- **JournalModal**: A high-fidelity viewer supporting rich text rendering, multi-page navigation, and editor modes for owners.

### 3. Global Chat (`src/client/ui/components/GlobalChat.tsx`)
- **Integrated DiceTray**: Visual interface for common dice rolls.
- **Roll Parsing**: Automatically detects and executes `/roll` commands.
- **Actor Attribution**: Automatically attaches the current user's selected actor as the "speaker".

### 4. Combat HUD (`src/client/ui/components/Combat/CombatHUD.tsx`)
A dedicated, real-time overlay for active encounters:
- **Turn Tracking**: Displays the current initiative order, highlighting the active combatant and round number.
- **Automated Appearance**: Automatically mounts and unmounts based on the Foundry world's combat state.
- **Universal Initiative**: Integrates with the `InitiativeModal` abstraction to provide a unified rolling experience across different RPG systems (handling advantage, distinct formulas, etc.).

### 5. Shadowdark Sheet (`src/modules/shadowdark/ui/ShadowdarkSheet.tsx`)
Specialized interface for the Shadowdark RPG, featuring:
- **Tabbed Navigation**: Abilities, Inventory, Spells, Talents, and Effects.
- **Real-Time Persistence**: Changes to stats or configuration are instantly synced to Foundry.
- **Level Up Wizard**: Guided UI for character progression.

---

## Technical Patterns

### 1. Notification System
A robust toast system supporting HTML content for dice results.
- **Usage**: `const { addNotification } = useNotifications();`

### 2. Loading & Reconnecting
The UI includes full-screen overlays for:
- **Initial Load**: Shows while the backend warms its compendium cache.
- **Auto-Reconnection**: Appears non-disruptively if the socket connection is lost.

### 3. Aesthetic Guidelines
- **Typography**: `Cinzel` for cinematic headings; `Inter` for functional body text.
- **Color Palette**: `Zinc-900` backgrounds with `Amber-500` (Gold) interactive accents.
- **Glassmorphism**: Extensive use of backdrop-blur (`backdrop-blur-md`) and semi-transparent layers.

---

## Module UI Loading

The platform resolves which system-specific React components to render via `getUIModule(systemId)` (`src/modules/registry/core/client.ts`). It determines the correct webpack import alias to use by consulting the server's active-source map:

| Alias | Points to | When used |
|---|---|---|
| `@local-modules` | `data/local/modules/` | Module source is `"local"` (active local dev version) |
| `@modules` | `src/modules/` then `data/modules/` | Module source is `"built-in"` or `"data"` (managed install) |

Both aliases are resolved at Next.js build time so no runtime filesystem access occurs in the browser — switching sources only changes which pre-bundled chunk is executed.

`getUIModule` caches results in memory. Call `invalidateModuleSourceCache()` (exported from `@modules/registry/client`) to clear the cache and force a re-fetch of the active-source map from `/api/registry/sources`.

### `ActorPageRouter` (`src/app/(player)/actors/[id]/page.tsx`)

Fetches the actor, resolves the system module via `getUIModule`, and mounts the module's `actorPage` component inside an `SDKProvider`. Falls back to `GenericActorPage` when the module does not provide one. Re-runs resolution automatically on `moduleSourceChanged` events — see below.

### `SheetRouter` (`src/client/ui/components/SheetRouter.tsx`)

Resolves and renders the module's `sheet` component inside an `SDKProvider`. Receives `systemId` as a prop from whatever parent renders the sheet modal.

---

## Real-time Socket Events

The platform uses Socket.io for all real-time updates. Events are emitted by the Core Service (`src/server/realtime/AppSocketGateway.ts`) and received in `FoundryContext` and individual page components.

| Event | Direction | Payload | Handler |
|---|---|---|---|
| `systemStatus` | Server → Client | Full status payload | `FoundryContext` — drives connection state machine |
| `actorUpdate` | Server → Client | `{ actorId }` | `FoundryContext` — fetches the single updated actor card |
| `combatUpdate` | Server → Client | Combat state payload | `FoundryContext` / `ActorCombatContext` |
| `chatUpdate` | Server → Client | New chat message | `ChatContext` |
| `sharedContentUpdate` | Server → Client | Shared media/journal payload | `FoundryContext` |
| `moduleSourceChanged` | Server → Client | `{ moduleId, source }` | `FoundryContext` + `ActorPageRouter` — see below |

### `moduleSourceChanged`

Emitted by `POST /admin/lifecycle/:moduleId/switch-source` after the server switches a module's active source between `"local"` (dev) and `"data"` (managed install).

**Client reaction — two layers:**

1. **`FoundryContext`** (always mounted): calls `invalidateModuleSourceCache()` to clear the source-map and manifest caches. If the affected module is the currently active system, nulls out `activeUIModule`, which triggers the `hydrateUI` effect to re-call `getUIModule()` with a fresh cache miss.

2. **`ActorPageRouter`** (mounted when a player has an actor page open): checks whether `moduleId` matches the system of the actor currently being viewed (stored in `resolvedSystemIdRef`). If it matches, increments `resolveKey`, which re-runs the full actor resolution — re-fetching the actor, re-loading the module UI from the new source, and remounting the component — without a page refresh.

The admin panel's `ModuleLifecycleControl` also calls `invalidateModuleSourceCache()` locally after a successful switch-source API call, so any actor opened in the same browser tab as the admin panel also picks up the change immediately.
