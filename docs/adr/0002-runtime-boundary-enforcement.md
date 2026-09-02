# ADR-0002: Runtime Boundary Enforcement (Player vs Admin Surfaces)

**Status:** Accepted
**Date:** April 22, 2026
**Phase:** 21
**Supersedes:** None (prerequisite layer below Phase 22)

---

## Context

The admin authentication foundation introduced a dedicated `/admin` control-plane surface separate from the gameplay surface. However, after implementation, a structural problem emerged:

The **Next.js root layout** was mounting the complete player runtime context stack globally, applying it to **all routes**, including `/admin` and undefined routes. This meant:

1. Navigating to `/admin` would:
   - Restore legacy Foundry player session from localStorage
   - Boot the Socket.IO realtime client
   - Trigger player bootstrap API calls (`/api/status`, `/api/actors`, `/api/chat`, `/api/shared-content`)
   - Render player overlays and UI components in the DOM

2. The admin surface was **not isolated**—it was receiving unwanted player runtime initialization and state management, even though it didn't use any of it.

3. This created several problems:
   - Unnecessary API calls and network churn when visiting `/admin`
   - Player context providers running in a context where they're not intended
   - Potential for accidental player state leakage or interference
   - Code clarity: developers could not visually/structurally distinguish where player runtime should exist

This violated a core boundary principle: **each runtime surface should manage its own composition**, not inherit a global one.

---

## Decision

Enforce **structural separation of runtime surfaces** using Next.js route groups as composition boundaries.

**Three runtime surfaces:**
1. **Player surface** (`/`, `/actors/:id`, `/tools/...`) — Full Foundry integration, session restore, realtime, overlays
2. **Admin surface** (`/admin`) — Isolated, no player runtime, minimal boot
3. **Backend API** (Express, port 8001) — Core service, unchanged

**Each surface** gets its own layout file with an explicit composition tree:
- Player layout mounts SessionProvider, RealtimeProvider, FoundryProvider, JournalProvider, ActorCombatProvider, ChatProvider, and all UI overlays
- Admin layout is minimal with no player providers
- Root layout reduced to HTML shell only (fonts, body, globals.css)

Next.js route groups (parenthesized folders like `(player)` and `(admin)`) enforce these boundaries structurally—not at auth time, but at composition time.

---

## Details

### Route Group Structure

```
src/app/
  layout.tsx                          ← Minimal root (fonts, body, CSS, children)
  favicon.ico
  globals.css
  (player)/                           ← Player composition
    layout.tsx                        ← Full provider stack + overlays
    page.tsx                          ← /
    actors/[id]/page.tsx              ← /actors/:id
    tools/[systemId]/[toolId]/page.tsx ← /tools/:systemId/:toolId
  (admin)/                            ← Admin composition
    layout.tsx                        ← Minimal layout, NO player providers
    admin/page.tsx                    ← /admin
```

### Root Layout: Minimal Shell

```typescript
// src/app/layout.tsx
// Only provides:
// - Font declarations
// - HTML/body structure
// - Global CSS
// - {children} placeholder
// Does NOT import any providers
```

**Effect:** Routes can no longer inherit player providers by default. Each route group explicitly declares what it needs.

### Player Layout: Full Composition

```typescript
// src/app/(player)/layout.tsx
// Mounts:
// - ConfigProvider
// - NotificationProvider
// - UIProvider
// - SessionProvider      ← Restores Foundry session from localStorage
// - RealtimeProvider     ← Socket.IO client
// - ActorCombatProvider
// - ChatProvider
// - FoundryProvider      ← Bootstrap API calls
// - JournalProvider
// - Player UI overlays (GlobalChat, PlayerList, FloatingHUD, etc.)
```

**Effect:** Only routes under `(player)` receive full player runtime. Visiting `/` mounts the full stack; leaving the player tree unmounts it.

### Admin Layout: Isolated Minimal

```typescript
// src/app/(admin)/layout.tsx
// Mounts:
// - Minimal metadata
// - Zero player providers
// - Empty div wrapper
```

**Effect:** `/admin` receives no player runtime, no session restore, no socket connection, no bootstrap. Clean slate.

### Defensive Guards (Runtime Validation)

For defense-in-depth, added `useRuntimeSurface()` hook and `assertPlayerSurface()` guard:

```typescript
// src/client/hooks/useRuntimeSurface.ts
export function useRuntimeSurface() {
  // Returns 'player' or 'admin' based on window.location.pathname
}

export function assertPlayerSurface() {
  // Logs warning if player context mounted on admin surface
  // This catches composition errors if defensive split fails
}
```

**SessionProvider** calls `assertPlayerSurface()` on mount. If a developer accidentally nests it in the wrong context, a console warning fires.

### Composition Isolation Guarantees

| Surface | SessionProvider | Socket.IO | `/api/status` call | Player overlays | Auth model |
|---|---|---|---|---|---|
| `/` (player) | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | Foundry session |
| `/admin` (admin) | ❌ No | ❌ No | ❌ No | ❌ No | App-admin token |

---

## Consequences

### Positive

1. **Clear boundary** between player and admin codepaths (structural, not just logical).
2. **Reduced coupling**: Admin surface doesn't boot player runtime by accident.
3. **Clearer intent**: Developers see at the filesystem level what composition each surface uses.
4. **Defensive isolation**: Guards catch composition mistakes early.
5. **Simpler testing**: Can test player and admin surfaces independently without cross-contamination.

### Tradeoffs

1. **Session does not persist across surface switches**: Navigating from `/` to `/admin` unmounts SessionProvider, clearing session state. This is **intentional**—separating concerns. If cross-surface session persistence is needed later, it would require moving session state above both route groups (XOR isolation).

2. **Route group convention**: Developers must understand Next.js route groups as composition boundaries, not just URL structure.

3. **Validation overhead**: Defensive guards add small runtime overhead (route check on SessionProvider mount). Cost is negligible; benefit (catch bugs early) is high.

---

## Related Decisions

- **ADR-0001 (Admin Authentication)**: Introduced app-admin identity model. This ADR ensures that identity is used in isolation from player runtime.
- **Admin Auth Foundation**: Implemented auth credentials, session tokens, CSRF protection. This phase assumes isolated runtime composition.
- **Phase 22 (Lifecycle Operations)**: Builds mutation APIs on top of isolated admin surface. Cannot proceed safely without this boundary.

---

## Validation

**Structural Verification:**
- Root layout (`src/app/layout.tsx`) contains **no imports** of SessionProvider, FoundryProvider, RealtimeProvider, or other player contexts
- Player layout (`src/app/(player)/layout.tsx`) mounts the complete provider stack: SessionProvider → RealtimeProvider → ActorCombatProvider → ChatProvider → FoundryProvider → JournalProvider
- Admin layout (`src/app/(admin)/layout.tsx`) contains no player provider imports or nesting

**Browser Validation (npm run dev):**
- Navigating to `/` (player) shows:
  - Network calls: `/api/status`, `/api/actors`, `/api/chat`, `/api/shared-content`, `/api/journals`, `/api/combats`
  - Socket.IO WebSocket connection active
  - Player overlays rendered: GlobalChat, PlayerList, FloatingHUD, CombatHUD, JournalBrowser, JournalModal
  - Session restored from localStorage via SessionProvider
- Navigating to `/admin` shows:
  - Network calls: only admin-surface bootstrap requests (for example account status), with **no player bootstrap calls**
  - **NO** Socket.IO connection
  - **NO** player overlays rendered
  - **NO** player API bootstrap calls
  - No player context initialization logs in console
- Switching from `/` to `/admin` cleanly unmounts player runtime (socket disconnects, session state cleared)

**Defensive Guard Validation:**
- `assertPlayerSurface()` guard in SessionProvider triggers no warnings on player routes (expected behavior)
- If SessionProvider were accidentally nested in admin layout, guard would log: `[Player Runtime Guard] Player context accessed on admin surface...` (safety net, not currently triggered)

---

## Exit Criteria

- [x] Root layout contains no player providers
- [x] Player layout contains full provider stack
- [x] Admin layout contains no player providers
- [x] Player routes isolated under `(player)` route group
- [x] Admin routes isolated under `(admin)` route group
- [x] Defensive guards in place (`useRuntimeSurface`, `assertPlayerSurface`)
- [x] Composition boundaries enforced at compile-time and runtime
- [x] All tests pass
- [x] Isolation validated in browser: confirmed no player bootstrap on `/admin`, verified socket disconnect on surface switch
