# ADR-0030: Admin Panel UX Modernization

**Status:** Accepted — Implemented.
**Date:** June 10, 2026
**Phase:** Admin UX
**Supersedes:** None
**Revises:** ADR-0006 Phase 27 admin operations UX (the single-route dashboard layout it delivered).
**Related:** ADR-0006 (admin operations UX and distribution readiness), ADR-0029 (admin control plane hardening — most recent work in `src/app/(admin)/`), ADR-0024 (client UI state decomposition).

---

**Current-state clarification (August 21, 2026).** Concrete system identifiers
in the interface sketches below are historical test fixtures, not required or
preferred modules. The operational rule is abstract: local development and
managed installation are distinct sources with distinct configurable
`<DATA_DIR>` paths, and the admin UI reports each source independently.

## Context

ADR-0006 Phase 27 delivered the admin operations UX: typed API client, module lifecycle dashboard, world controls, source profiles, audit log, cache view, system overview, and a light/dark theme system. The functionality is complete and the implementation is cohesive — there is a real `--admin-*` design-token system, skeleton loaders, a toast system with `aria-live`, confirmation flows for destructive actions, and dry-run previews.

What the panel lacks is the structural scaffolding that production admin backends rely on. A look-and-feel review of `src/app/(admin)/` (June 10, 2026) found the following, recorded here inline since the working notes are not a durable reference:

**Information architecture**
- The entire panel is a single route (`/admin`, `admin/page.tsx`) that renders every area — System Overview, World Management, Module Lifecycle, Source Profiles, Audit Log, Cache — stacked vertically as collapsible `DashboardSection`s. There is no primary navigation, no deep-linking or history, no "where am I" indicator, and the operator scrolls a long way to reach lower sections. Module Lifecycle alone can be tall (one card per module/source).
- Conceptually related areas are split apart: Module Lifecycle and Source Profiles are both "modules" concerns but live as separate top-level sections.
- Section collapse/expand state is local component state, reset on every reload.

**Global chrome**
- The header (title, theme toggle, logout) lives inside the scrolling content and scrolls away. There is no sticky top bar.
- Core Service / world connection health is only visible inside the first card (`SystemInfoCard`); when the backend is down each panel errors independently with no unifying explanation.
- The logged-in operator identity (`adminId`) is never displayed.
- There is no environment (dev/prod) indicator, despite the panel being able to restart the server and mutate module state.

**Visual system**
- Every panel uses `rounded-[28px]`, very large shadows (`0_24px_80px_rgba(...)`), and `backdrop-filter: blur(18px)` — a consumer/marketing aesthetic that costs vertical density in an operations tool.
- Buttons mix `rounded-xl`, `rounded-2xl`, and `rounded-full` with padding ranging `px-3 py-1.5` → `px-4 py-3`; there is no shared button primitive, so variants drift.
- Section titles render twice: `DashboardSection` renders the title in its toggle header and the panel inside also renders its own `<h2>` (World Management, Module Lifecycle, Audit Log, Cache Info each appear twice).
- Logout uses the danger/red button style even though logging out is not destructive.

**Accessibility**
- Collapsible headers lack `aria-expanded` / `aria-controls`; some glyph-only buttons (toast close) lack labels; focus-visible rings are inconsistent across hand-rolled buttons.

**Module-area mental model (operator observations)**
- **Only one module is operative at a time.** Foundry runs a single active world, hence a single active system, so at most one system module can actually be in effect. The lifecycle UI nonetheless presents every module as an independent on/off toggle, and `checkCanEnableModule` only validates dependencies/conflicts — nothing models or surfaces single-active reality. The result misleads: an operator can toggle several modules "enabled" with no indication that only the one matching the connected world's system is live.
- **Local dev and packaged/managed modules are not visually distinguished, and can appear to share a location.** They are physically separate on disk — local dev lives at `<DATA_DIR>/local/modules/<moduleId>` (`getLocalModulesDir`, paths.ts:254) and managed/packaged at `<DATA_DIR>/modules/<moduleId>` (`getModulesDataDir`, paths.ts:249). But the lifecycle record carries a single `directory` field that is **reassigned to whichever source is active** on switch (`moduleSources.ts:142–155`: local → `record.localDirectory`, managed → `getModulesDataDir()/<id>`). The admin payload exposes that mutated `directory`, so when a module exists as both a local dev copy and a managed install, a card can show the location of the *other* source rather than its own — making the two origins look like one.

None of these are correctness defects — the panel works. They are usability and scalability gaps relative to standard admin-backend conventions (persistent navigation, sticky context chrome, a tightened visual system, accessible disclosure), plus two mental-model gaps in the module area that mislead operators about what is actually active and where it lives.

## Decision

Modernize the admin panel around a **persistent left-sidebar navigation with routed sub-pages**, a **sticky top context bar**, and a **tightened, shared visual system**, delivered in phases. The existing `--admin-*` token system and the `adminApi.ts` client are retained; this is a presentation/IA change, not a data or backend change.

The decision has five parts.

### 1. Navigation Is a Persistent Left Sidebar Over Routed Sub-Pages

The single mega-page is decomposed into route segments under the existing `(admin)/layout.tsx` shell, which already wraps the panel in theme/auth/toast providers. Each area becomes its own page that mounts (and fetches) only when visited:

```
/admin                  → Overview (system + world status at a glance)
/admin/modules          → Module Lifecycle (Installed)
/admin/modules/sources  → Source Profiles
/admin/world            → World Management
/admin/audit            → Audit Log
/admin/cache            → Cache
```

The sidebar is rendered once in the layout, shows active state for the current route, and groups related areas (Modules → Installed / Sources). A sidebar — not tabs — is the chosen model: the content depth (Module Lifecycle) benefits from a stable, always-visible nav with room to grow, and it matches the convention operators expect from admin backends.

### 2. A Sticky Top Bar Carries Global Context

A top bar lives in the layout, above the content, and stays fixed. It carries: product/brand, an **environment badge** (dev/prod), a **Core Service connection indicator**, the **current admin identity**, the theme toggle, and logout. This keeps global state and global actions visible regardless of scroll position, and gives a single home for the connection-health and identity signals that are currently absent or buried.

### 3. The Visual System Is Tightened and Shared

Keep the color tokens; restrain the geometry. Define a spacing/radius scale and pull panels back from `rounded-[28px]` + heavy shadow + blur toward `~rounded-xl` (12px), hairline borders, and shadow reserved for genuinely floating elements (toasts, menus, drawers). Introduce shared primitives — at minimum `Button` (primary / secondary / danger / ghost; sm / md), `EmptyState`, and `ErrorState` — backed by the tokens, and migrate panels onto them so radius, padding, disabled, and focus-ring styling are defined once.

### 4. Headings, Color Semantics, and Disclosure Are Corrected

- Each area's title is owned by the route/page chrome; in-panel duplicate `<h2>`s are removed.
- Red is reserved for destructive actions; logout becomes a neutral/secondary control.
- Disclosure controls expose `aria-expanded` / `aria-controls`; glyph-only buttons get `aria-label`s; the shared `Button` primitive provides a visible `focus-visible` ring.

### 5. Module Detail and Audit Depth Move Out of the Inline Scroll

- Module detail/operations move from the nested inline accordion (`ModuleDetailPanel` → `ManagerActionBar` → `DryRunPreview` stacked in-column) into a **right drawer or a `/admin/modules/[id]` detail route**, keeping the list scannable.
- The audit view gains real filtering (date range + text, server-side if volume grows), a per-row detail expander surfacing the full event (outcome, duration, user-agent already exist server-side), and a unified "updated Ns ago" + refresh affordance shared with the other data panels.

### 6. The Module Area Reflects Single-Active Reality and Distinguishes Source Origins

The Module Lifecycle area is reframed so its presentation matches how the runtime actually behaves.

**Single active system.** The UI makes clear that at most one system module is operative — the one matching the connected world's system. The connected system id is already available from the admin status payload (`system.id`), so the area can cross-reference it and mark the corresponding module **Active** (distinct from merely "enabled" in persisted lifecycle state), visually de-emphasizing the others as inert. Module selection is presented as choosing the active system (a single-selection mental model) rather than as N independent switches. This is a presentation change layered on the existing lifecycle data; it does not redefine the enable/disable API or add a server-side single-active constraint.

**Source-origin distinction.** Local dev and managed/packaged modules are treated as visibly different origins, each always showing its own true, fixed location regardless of which source is currently active:
- Local dev → `<DATA_DIR>/local/modules/<moduleId>`
- Managed → `<DATA_DIR>/modules/<moduleId>`

To support this, the admin lifecycle payload exposes **per-source directories** (an explicit `managedDirectory` alongside the existing `localDirectory`) rather than the single, active-source-mutated `directory` the cards read today. Each source card renders its own path from these fields, and the local-vs-managed distinction is reinforced with clear labeling/iconography so an operator can never mistake one origin for the other. This is the one place the ADR permits a small, read-only server-side payload addition (see Non-Goals).

## Target Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ ◆ SheetDelver Admin      [DEV] ● Core: Connected   admin-1735…  ☼ ⎋ │  ← sticky top bar
├───────────────┬────────────────────────────────────────────────────┤
│ ▸ Overview    │  Modules — Installed         World system: dnd5e  │
│ ▾ Modules     │  ┌──────────────────────────────────────────────┐  │
│   • Installed │  │ dnd5e   Managed v2.1.0    ★ ACTIVE  [Details]  │  │
│   • Sources   │  │   <DATA_DIR>/modules/dnd5e                     │  │
│ ▸ World       │  │ shadowdark  Local Dev     ○ inactive [Details] │  │
│ ▸ Audit       │  │   <DATA_DIR>/local/modules/shadowdark         │  │
│ ▸ Cache       │  │ morkborg    Managed       ○ inactive [Details] │  │
│               │  │   <DATA_DIR>/modules/morkborg                  │  │
│               │  └──────────────────────────────────────────────┘  │
│               │  (only the module matching the world system is     │
│               │   live; detail opens in a drawer or /modules/[id])  │
└───────────────┴────────────────────────────────────────────────────┘

(admin)/layout.tsx
  └─ AdminProviders (theme / auth / toast)   ← unchanged
     └─ AdminShell
        ├─ <AdminTopBar/>      (brand, env, connection, identity, theme, logout)
        ├─ <AdminSidebar/>     (nav, active state, grouped areas)
        └─ <main>{children}</main>   ← routed page content
```

Each route segment is a focused page rendering one area's existing panel component (headingless), reusing the current `adminApi.ts` calls unchanged.

## Implementation Plan

### Phase UX-1: Quick Wins (no structural change)

- Remove the duplicate in-panel `<h2>` headings (World/Module/Audit/Cache).
- Neutralize the Logout button color (reserve red for destructive actions).
- Persist `DashboardSection` collapse state to `localStorage` (interim, until UX-3 replaces sections with routes).
- Add `aria-expanded` / `aria-controls` to disclosure controls and `aria-label`s to glyph-only buttons.
- Convert the theme toggle to a compact icon control (keep its `aria-label`).

These are component-local and independent of the routing change; they deliver immediate visible cleanup.

**Backend prerequisite:** none — all items are frontend-only.

**Phase UX-1 completed: June 10, 2026**

Delivered:
- Removed the duplicate in-panel `<h2>` headings (World/Module/Audit/Cache) from both skeleton and main renders; `DashboardSection` is now the sole owner of each section title, and the panel header rows right-align their actions.
- Logout button restyled from danger/red to a neutral secondary control.
- `DashboardSection` collapse state persists to `localStorage` and exposes `aria-expanded`/`aria-controls` on the toggle.
- Theme toggle converted to a compact sun/moon icon button (keeps its `aria-label`); toast close button gained `aria-label`.
- `tsc --noEmit`, lint on changed files, and `npm run test:unit` all pass.

### Phase UX-2: Sticky Top Bar

**Backend prerequisite (additive, read-only — land first in this slice):**
- Add an `environment` flag (`'development' | 'production'`) to the admin status payload (`GET /admin/status`). `NODE_ENV` is server-only and nothing surfaces it today, so the env badge cannot be rendered without it.
- Make the current operator identity available after a page reload. Today `adminId` is returned by login/setup but discarded by the client, and there is no way to recover it once only the stored token remains. Add a lightweight `GET /admin/auth/me` (returns the authenticated `adminId`) — preferred over having the client parse the token blob.
- The connection indicator needs no new field; it derives from the existing `connected` / `worldState` already in the status payload.

Implementation:
- Add `<AdminTopBar/>` in the layout shell with brand, environment badge, Core Service connection indicator, current admin identity, theme toggle, and logout.
- Surface a single top-level offline banner when the Core Service is unreachable, so panels stop each rendering their own disconnected error.
- Persist the `adminId` from `/auth/me` (or login) in the auth context so the top bar can render identity across reloads.

Can land before the routing change, sitting above the current stacked sections.

**Phase UX-2 completed: June 10, 2026**

Delivered:
- Backend (additive, read-only): `environment` (`'development' | 'production'`) added to the `GET /admin/status` payload; new `GET /admin/auth/me` (account-exists + admin-auth gated) returns the authenticated `adminId`.
- `AdminAuthContext` now exposes `adminId`, captured from login/setup responses and restored via `/auth/me` on reload, cleared on logout.
- New `AdminTopBar` (sticky): brand, environment badge (DEV/PROD), Core Service connection indicator (connected/disconnected/offline), operator identity, theme toggle, and logout — plus a single top-level offline banner when the Core Service is unreachable. The in-page header was reduced to the page heading; theme/logout now live in the bar.
- Route test asserts `/auth/me` is registered and requires admin auth. `tsc --noEmit`, lint, and `npm run test:unit` pass.

(The top bar is mounted in the dashboard page for now; UX-3 relocates it into the shared layout shell.)

### Phase UX-3: Sidebar Navigation and Routed Sub-Pages

- Introduce `<AdminSidebar/>` in the layout with active-route state and grouped areas (Modules → Installed / Sources).
- Create route segments (`/admin`, `/admin/modules`, `/admin/modules/sources`, `/admin/world`, `/admin/audit`, `/admin/cache`); move each area's panel into its segment, rendered headingless under a page-level title.
- Replace the mega-page `DashboardSection` stack with the routed layout; remove the interim collapse-persistence from UX-1.
- Preserve auth gating (login/setup) at the layout level so it applies across all routes.
- Add focused tests/checks that each route mounts its panel and that unauthenticated access still gates to login.

This is the structural backbone and the only phase that changes file/route structure.

**Backend prerequisite:** none — routing/navigation is frontend-only against existing endpoints.

**Phase UX-3 completed: June 10, 2026**

Delivered:
- New authenticated shell layout `(admin)/admin/layout.tsx` owns auth gating (loading → login → shell) once for all sub-routes and renders the persistent chrome: `AdminTopBar` (relocated here from the page) + new `AdminSidebar` + routed `<main>`.
- New `AdminSidebar` with active-route state (`usePathname`, `aria-current`) and grouped areas (Modules → Installed / Sources).
- Route segments created and each panel moved into its own headingless page under a shared `PageHeading`: `/admin` (Overview), `/admin/world`, `/admin/modules`, `/admin/modules/sources`, `/admin/audit`, `/admin/cache`.
- The single mega-page and its `DashboardSection`/`ChevronIcon` (and the interim UX-1 collapse persistence) were removed.
- `SourceProfilePanel` is now self-sufficient — it fetches its own installed-module lifecycle list (previously fed from a sibling panel) and refreshes it after install.
- Verification: `npx tsc --noEmit`, lint on all new/changed `(admin)/` files, and `npm run test:unit` pass. Route-mount/auth-gating is covered by type-compilation of the segment tree + the shell layout's single gate; there is no jsdom/RTL harness in this repo for runtime Next-page mount tests, so a manual light/dark pass across routes remains the final visual gate.

### Phase UX-4: Visual System Consolidation

- Define the spacing/radius/shadow scale; retune panels to the tightened geometry.
- Add shared `Button`, `EmptyState`, and `ErrorState` primitives backed by the tokens; migrate panels onto `Button` to remove shape/size drift and centralize focus/disabled styling.
- Verify light and dark themes against the new geometry.

Best done after UX-3 so the primitives are applied once, within the new structure.

**Backend prerequisite:** none — token/component work is frontend-only.

**Phase UX-4 completed: June 10, 2026**

Direction (operator sign-off): tighten significantly — compact, utilitarian geometry — with a note to watch row density and revisit separating local vs managed modules if it gets cramped (carried into UX-6).

Delivered:
- New shared primitives under `(admin)/components/ui/`: `Button` (variants primary/secondary/danger/ghost; sizes sm/md; centralized radius `rounded-md`, focus-visible ring, disabled styling), `EmptyState`, and `ErrorState`.
- Geometry tightened across all `(admin)` components: `rounded-[28px]`→`rounded-xl`, `rounded-[24px]`/`rounded-2xl`→`rounded-lg`, heavy `shadow-[0_24px_80px…]`/`[0_18px_60px…]`→`shadow-sm`. `.admin-panel` dropped the `blur(18px)` backdrop and gradient for a flat surface + hairline border.
- Core data panels migrated onto the primitives: World, Cache, Audit, and Module Lifecycle now use `Button` for their toolbar/refresh/load-more actions and `EmptyState`/`ErrorState` for their empty/error blocks; the top-bar logout uses `Button` too.
- Scoping note: the contextual `ManagerActionBar` and `SourceProfilePanel` action buttons retain their bespoke per-state variant logic (already radius-tightened by the bulk pass); they can adopt `Button` incrementally without behavior change.
- `tsc --noEmit`, lint across `(admin)`, and `npm run test:unit` pass.

### Phase UX-5: Panel Depth

- Move module detail/operations into a right drawer or `/admin/modules/[id]` route (out of the inline nested accordion).
- Add audit filtering (date range + text), per-row detail expansion, and a shared "updated Ns ago" + refresh affordance across data panels.
- Replace World Management's fixed 2s post-action delay with world-state polling until settled (bounded), showing a transitional state.
- Add priority reorder controls (up/down or drag) to Source Profiles.

**Backend prerequisite:** none required — all items work against existing endpoints (world-state polling uses the status payload; source reorder uses `updateSourceProfile`'s `priority`; audit filtering starts client-side). *Optional:* add server-side audit filtering (date range + text) to `GET /admin/audit` only if event volume outgrows client-side filtering of the loaded window.

**Phase UX-5 completed: June 10, 2026**

Delivered:
- New `Drawer` primitive (right slide-over); module detail/operations moved out of the inline accordion-in-accordion into the drawer — the "Details" button opens it, the list stays scannable. `ModuleCard` no longer renders `ModuleDetailPanel` inline.
- Audit view depth: a live "updated Ns ago" indicator, a free-text search (method/path/admin/IP/status, client-side over the loaded window), and per-row expansion showing the full event (event id, admin, method+path, outcome, status, duration, IP, user-agent).
- World Management: the fixed 2s post-action delay replaced with bounded world-state polling (≤12 × 1.5s) until the state settles to the expected target (connected for launch/retry, closed for shutdown).
- Source Profiles: up/down priority reorder controls (swap priority with the adjacent profile; the protected default local source stays pinned), backed by `updateSourceProfile`.
- Server-side audit date-range filtering was left as the documented optional item (not needed at current volume).
- `tsc --noEmit`, lint across `(admin)`, and `npm run test:unit` pass.

### Phase UX-6: Module Area Semantics (single-active + source origins)

**Backend prerequisite (additive, read-only — land first in this slice):**
- Add `managedDirectory` to the `GET /admin/lifecycle` payload alongside the existing `localDirectory`, derived from `getModulesDataDir()/<id>`. **Hard requirement:** the managed path is an absolute server path the browser cannot construct, and today's single `directory` is mutated to whichever source is active (`moduleSources.ts:142–155`), so the client cannot otherwise show the non-active source's true location.
- *Optional but recommended:* add an explicit active-system signal (e.g. `activeSystemId` on the status payload, or an `isActive` flag per lifecycle entry) so the Active marker is authoritative rather than inferred from client-side `system.id`-to-`moduleId` matching. If omitted, the client falls back to case-insensitive matching against the existing `system.id`.

Implementation:
- Have each source card render its own fixed path from `localDirectory` / `managedDirectory` instead of the active-source-mutated `directory`.
- Reinforce the local-dev vs managed/packaged distinction with clear labels/iconography on every card and in the detail view.
- Mark the operative module **Active** (from the active-system signal, or the `system.id` fallback), distinct from persisted "enabled" state, and de-emphasize inert modules.
- Reframe the list around single-system selection (the active module is highlighted; others are clearly inactive) without changing the enable/disable API.
- Add checks that per-source paths render correctly when a module exists as both local and managed, and that the Active marker tracks the connected system id.

Depends on UX-3 (module routing) and pairs naturally with UX-5 (module detail drawer/route).

**Phase UX-6 completed: June 10, 2026** (done ahead of UX-5 per operator priority on the local/managed distinction)

Delivered:
- Backend (additive, read-only): `managedDirectory` (`<DATA_DIR>/modules/<id>`) added to the `GET /admin/lifecycle` payload, independent of the active-source-mutated `directory`.
- Each module card now shows its **own fixed location** — local cards render `localDirectory`, managed/single cards render `managedDirectory` — so a module present as both local and managed no longer shows a shared/active path. The detail panel's managed Location uses `managedDirectory` too. Existing Local Dev / Managed origin badges are retained alongside.
- Single-active reality surfaced: `ModuleLifecycleControl` resolves the connected world's `system.id` (client-side from the status payload — the optional `activeSystemId`/`isActive` server signal was not needed) and marks the operative card with a **★ Active** badge (module matches the connected system, this source is active, and enabled). A header hint states that only the module matching the connected system is live and names it.
- `tsc --noEmit`, lint, and `npm run test:unit` pass.

Note (carried from the UX-4 sign-off): if the per-card location line makes rows feel cramped, the local/managed split is a candidate for a more deliberate two-column or grouped presentation in a follow-up.

## Non-Goals

- No backend or route-handler logic changes, with one narrow exception: the admin lifecycle payload (`GET /admin/lifecycle`) may add **read-only per-source directory fields** (`managedDirectory` alongside `localDirectory`) to support the source-origin distinction in Decision 6. This is additive and presentation-supporting; it does not change enable/disable/install semantics or the auth contract.
- No server-side single-active-system enforcement. Decision 6's single-active treatment is presentation only (cross-referencing the connected `system.id`); the enable/disable API is unchanged.
- No other `adminApi.ts` contract changes. Otherwise this is presentation/IA only.
- No change to the auth/security model (ADR-0029 stands).
- No new color palette — the existing `--admin-*` tokens are retained; only geometry/density and component structure change.
- No tabs-based navigation (see Alternatives).
- No command palette / keyboard-shortcut layer in this ADR (possible later nicety).
- No multi-operator-specific UI (consistent with ADR-0029 Amendment 2: multi-admin is not a tracked concern).

## Alternatives Considered

### Top tabs instead of a sidebar

Rejected as the primary model. Tabs are a lighter-weight option and would work for a single-operator tool, but they scale poorly as areas/sub-areas grow (Modules already wants Installed/Sources sub-navigation) and offer no stable, always-visible map of the panel. A sidebar is the convention operators expect and accommodates grouping and growth. Tabs remain a viable fallback if a sidebar proves too heavy in practice.

### Keep the single-page mega-scroll, just improve styling

Rejected. Styling fixes (UX-1/UX-4) help, but the core usability problems — no deep-linking, no history, long scroll, no active-location indicator, eager mounting of every panel — are structural and only addressed by routed navigation.

### Client-side section switching without real routes

Rejected. Switching visible sections via local state (instead of route segments) would give a nav bar without the deep-linking, browser history, or lazy mounting that Next App Router routes provide for free, and would not align with the existing layout/segment conventions in the codebase.

### Enforce single-active-system server-side (Decision 6)

Rejected for this ADR. Foundry already constrains the runtime to one active world/system, so the operative module is determined by what world is connected, not by an admin toggle. Modeling "Active" as a presentation layer over the connected `system.id` reflects reality without narrowing the general enable/disable/install API or adding a stateful constraint the manager would have to maintain and reconcile. A server-side active-system concept can be revisited if the manager ever needs to gate operations on it, but it is unnecessary to fix the operator-facing confusion.

### Surface a single shared `directory` and just relabel it (Decision 6)

Rejected. The single `directory` field is mutated to the active source's path (`moduleSources.ts:142–155`), so no amount of relabeling makes a card show the correct location for the *non-active* source. Distinct, fixed per-source fields (`localDirectory` / `managedDirectory`) are the minimal honest representation.

## Consequences

### Positive

- Operators get a stable navigation map, deep-linkable areas, and browser history.
- Global state (connection, environment, identity) is always visible; backend-down is explained once, not six times.
- A shared visual system removes button/heading drift and increases information density.
- Panels mount lazily per route, reducing initial fetch load.
- Accessibility of disclosure and focus improves materially.

### Tradeoffs

- UX-3 changes the route/file structure under `(admin)/`, the one larger, higher-touch phase.
- A tightened visual direction is a taste call; the heavy aesthetic has its admirers and the change is visible.
- Moving module detail to a drawer/route (UX-5) is a behavior change operators must re-learn.

## Validation

This ADR is complete when:

- The panel presents a persistent sidebar with active-route state and a sticky top bar carrying environment, connection, identity, theme, and logout.
- Each admin area is its own route, deep-linkable, mounting its panel on visit, with auth gating preserved across routes.
- Section titles appear once; logout is not red; disclosure controls expose `aria-expanded`/`aria-controls` and glyph buttons have labels.
- Panels use shared `Button`/`EmptyState`/`ErrorState` primitives and the tightened geometry, in both light and dark themes.
- Module detail opens out of the inline accordion; the audit view supports filtering and per-row detail.
- Each module source card shows its own fixed location (local `<DATA_DIR>/local/modules/<id>` vs managed `<DATA_DIR>/modules/<id>`) and is unmistakably labeled by origin; the module matching the connected world's system is marked Active and others read as inactive.

Expected verification gates:

- `npx tsc --noEmit`
- focused lint on changed `src/app/(admin)/` files
- `npm run test:unit` (and any added route-mount/auth-gate checks)
- manual light/dark visual pass across all routes

## Implementation Tracking

Status board:
- Phase UX-1 (Quick wins): ✅ Completed (June 10, 2026)
- Phase UX-2 (Sticky top bar): ✅ Completed (June 10, 2026)
- Phase UX-3 (Sidebar + routed sub-pages): ✅ Completed (June 10, 2026)
- Phase UX-4 (Visual system consolidation): ✅ Completed (June 10, 2026)
- Phase UX-5 (Panel depth): ✅ Completed (June 10, 2026)
- Phase UX-6 (Module area semantics — single-active + source origins): ✅ Completed (June 10, 2026)

This ADR should be updated per-phase as work advances, mirroring the completion discipline used in ADR-0006, ADR-0028, and ADR-0029.
</content>
