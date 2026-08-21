# ADR-0009: Source Browser UX (Phase 28.5)

**Date**: 2026-05-02
**Status:** Accepted
**Related**: ADR-0007, ADR-0008

**Current-state amendment (August 21, 2026).** The version-tagged
`data/modules/[moduleId]-[version]` layout below is historical. Managed
artifacts now occupy `<DATA_DIR>/modules/<moduleId>`, local development uses
the separate `<DATA_DIR>/local/modules/<moduleId>` root, and the registry
exposes those origins as `managed` and `local` respectively.

## Context
In ADR-0007 (Distribution Infrastructure), we introduced Source Profiles and remote index retrieval. However, we explicitly scoped out a "Public marketplace or submission workflow," operating under the assumption that backend API tests or manual HTTP requests would suffice to test the distribution pipeline for the pilot extraction (ADR-0008). 

During practical end-to-end testing, we found this lack of visibility into remote modules counterproductive. When an administrator clicks "Test Connection" on a Source Profile, they expect to see the modules discovered on that remote index and be able to install them from the UI. Without this, the administrative loop is incomplete.

## Decisions

1. **Expand Roadmap (Phase 28.5)**
   We will formally introduce a "Source Browser UI" to the Admin Dashboard. This bridges the gap between Source Profiles (ADR-0007) and Pilot Extraction testing (ADR-0008).

2. **Inline Source Browsing**
   Rather than building a full-scale global "Marketplace" with aggregated searching and categorizations, we will implement a lightweight, localized browser. Administrators can browse a specific Source Profile, view the `ModuleIndexDocument` contents associated with it, and initiate an installation directly.

3. **Contextual Action States (Install/Update/Re-install)**
   To provide clear operational feedback, the browser UI will cross-reference available remote modules with those already installed. Button labels and styles will dynamically shift:
   - **Install**: Module is not present on disk.
   - **Update**: A different version of the module is installed (Orange).
   - **Re-install**: The exact same version is already installed (Gray).

4. **Physical Version Isolation**
   To prevent file conflicts and ensure clean upgrades, artifacts will be extracted into version-tagged directories (e.g., `data/modules/[moduleId]-[version]`). The registry remains the source of truth for the active module by mapping the ID to the specific versioned directory.

5. **Shared Dashboard State**
   The Source Browser and Module Lifecycle panels will share an `installedModules` state in the parent `AdminPage`. This ensures that installing a module in one panel triggers an immediate reactive update in the other without a full page refresh.

## Consequences
- Administrators can now browse external modules without leaving the dashboard or resorting to raw API requests.
- The platform remains decentralized; instead of one monolithic marketplace, we browse specifically configured registry sources.
- Version-tagged directories improve operational transparency and reduce the risk of state drift or file corruption during upgrades.
- Real-time UI synchronization provides immediate feedback, completing the administrative loop for remote distribution.

---

## Implementation Outcome

Implementation completed as part of the Phase 28/29 stabilization effort.

1. Inline Source Browsing
- Integrated "Browse" capability directly into `SourceProfilePanel.tsx`.
- Implemented `GET /admin/sources/:id/modules` to retrieve remote index contents.

2. Contextual Action States
- Implemented logic to cross-reference remote modules with local `installedModules` state.
- Added dynamic button states: **Install** (Green), **Update** (Orange), and **Re-install** (Gray).

3. Shared Dashboard State
- Lifted `installedModules` state to the parent `AdminPage` to ensure reactive updates across panels.
- Verified that installing a remote module immediately updates the lifecycle list and browser states.

This ADR is now closed as implemented.
