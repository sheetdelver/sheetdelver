# Contributing to SheetDelver

Welcome to **SheetDelver**! We appreciate your interest in contributing to this extensible character sheet manager.

## Getting Started

### Prerequisites
- Node.js 18+
- A running instance of Foundry VTT (v13+)
- Access to the target Foundry world with a user account.

### Installation

1.  **Clone the repository:**
    ```bash
    git clone git@github.com:juvinious/sheet-delver.git
    cd sheet-delver
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

4.  **Configure connection:**
    Follow the [Configuration instructions in README.md](README.md#configuration) to create your `settings.yaml` file.
    Ensure `security.service-token` is set (or export `APP_SERVICE_TOKEN`) for privileged internal bearer flows.

5.  **Run the development server:**
    ```bash
    npm run dev
    ```
    Open [http://localhost:3000](http://localhost:3000) in your browser.

## Project Structure

SheetDelver follows a **Decoupled Core/Shell** architecture to ensure stability and separation of concerns.

- `src/core`: The **Engine**. Contains headless Foundry logic, socket maintenance, and system registries.
- `src/shared`: Common TypeScript **Interfaces and Types** shared between backend and frontend.
- `src/server`: The **Core Service**. Express API that wraps the Core logic and provides REST endpoints (App API and Admin API).
- `src/app`: The **Frontend Shell**. Next.js application containing the UI. API requests are forwarded to the Core Service via Next.js rewrite rules.
  - `ui/`: React components and hooks.
- `src/modules`: Pluggable **RPG System Modules**. Each module contains its own Adapter and Sheet UI.
- `src/cli`: The **Admin Console**. CLI tool for world management and authenticated scrapes.
- `src/scripts`: Tooling, build scripts, and the unified startup manager.
- `src/tests`: Automated unit and integration tests.

## Module Architecture & Vertical Slices

Each RPG system is implemented as a **Vertical Slice** within `src/modules/<system_id>/`.

*   **Everything belongs to a Module**: If you are adding support for a new RPG system (e.g., Pathfinder), *all* code related to that system (Types, Adapter logic, React Components, CSS) must reside in `src/modules/pathfinder/`.
*   **The SystemAdapter Contract**: Each module must implement the `SystemAdapter` interface defined in `src/modules/core/interfaces.ts`. This interface handles:
    *   **Data Fetching**: `getActor(client, id)` (running in browser context via Playwright).
    *   **Normalization**: `normalizeActorData(actor)` (converting raw Foundry data to a UI-friendly shape).
    *   **Computed Data**: `computeActorData(actor)` (optional, for derived stats like AC, HP, slots).
    *   **Item Categorization**: `categorizeItems(actor)` (optional, for grouping items like Weapons/Spells).
    *   **Rolling**: `getRollData(...)` (handling system-specific dice logic).
    *   **Data Resolution Fallback**: `resolveDocument(client, uuid)` (providing a local fallback for documents that fail to fetch via socket).
    *   **Theming**: `theme` (colors/fonts) and `componentStyles` (granular overrides for `ChatTab`, `DiceTray`, etc.).
*   **Isolation**: Do not import code from other system modules. Shared UI components (like `RichTextEditor`, `DiceTray`) are available in `@/components`.
*   **Registry**: Frontend components that need valid server-side rendering or dynamic imports (like Dashboard Tools) are registered in `src/modules/core/component-registry.tsx`.

## Adding a New System

1.  **Create Directory**: Create `src/modules/<system-id>/`.
2.  **Metadata**: Add `info.json`:
    ```json
    { 
        "id": "mysystem", 
        "title": "My RPG System",
        "actorCard": {
            "subtext": ["details.class", "details.ancestry", "level.value"] 
        }
    }
    ```
    *   `actorCard.subtext`: Optional. Array of dot-notation paths to display on the dashboard character card (e.g. "Wizard, Elf • Level 1"). If omitted, it defaults to the actor type.
3.  **Implement Adapter**: Create `system.ts` and implement `SystemAdapter`.
4.  **Implement Rules (Optional)**: Create `rules.ts` for calculations.
5.  **Create Sheet**: Create `ui/MySystemSheet.tsx`.
6.  **Create Actor Page**: Create `ui/pages/ActorPage.tsx`. This component handles the data fetching and layout for your system's character sheet page. If omitted, the system will use the Generic fallback.
7.  **Export Manifest**: Create `index.ts`:
    ```typescript
    import React from 'react';
    import { ModuleManifest } from '../core/interfaces';
    import { MySystemAdapter } from './system';
    import info from './info.json';

    const manifest: ModuleManifest = {
        info,
        adapter: MySystemAdapter,
        sheet: React.lazy(() => import('./ui/MySystemSheet')),
        actorPage: React.lazy(() => import('./ui/pages/ActorPage'))
    };
    export default manifest;
    ```
8.  **Register Module**: Open `src/modules/core/registry.ts`, import your manifest, and add it to the `modules` array.
9.  **Dashboard Tools (Optional)**: If your system has custom dashboard widgets (like a Character Generator), create the component in `ui/MySystemTools.tsx` and register it in `src/modules/core/component-registry.tsx`.

## Module API & Server-Side Logic

Modules can define server-side API handlers that are automatically routed via `/api/modules/<systemId>/<route>`.
For details on implementing module APIs, see [docs/API.md](docs/API.md).

## Data Persistence & Caching

SheetDelver uses a persistent cache to store metadata and improve resolution reliability.

*   **Setup Scraper Cache**: Discovery data for worlds and users is stored in `.sheet-delver/cache.json`.
*   **Compendium Indices**: CoreSocket caches compendium indices locally to speed up `fetchByUuid` operations.

### High-Reliability Resolution: resolveDocument

To ensure system-critical data (like spell descriptions) always loads efficiently even if network requests are slow or restricted:

1.  **Adapter Resolution**: `CoreSocket.fetchByUuid` first calls the active module's `resolveDocument(client, uuid)` hook. This allows for near-instant resolution of documents from local JSON data (e.g., via a `DataManager`).
2.  **Core Fetch**: If the adapter cannot resolve the document, CoreSocket attempts a network fetch using the standard Foundry socket operations.
3.  **High-Reliability Fallback**: This multi-stage process ensures that system-critical data remains available with minimal latency.

## Logging & Debugging

SheetDelver employs a centralized logging system to maintain clean output across both the server and the browser console.

### Log Levels
Use the appropriate level for your messages:
*   **ERROR** (1): Critical failures that require attention (e.g., connection loss, API errors).
*   **WARN** (2): Non-critical issues or deprecated usage.
*   **INFO** (3): Standard operational events (e.g., "Connected to World", "User Logged In"). **Default**.
*   **DEBUG** (4): Verbose dev info (e.g., socket payloads, state transitions).

### Configuration
The log level is set in `settings.yaml`:
```yaml
debug:
    enabled: true
    level: 3  # 0=None, 1=Error, 2=Warn, 3=Info, 4=Debug
```
Both the backend and frontend respect this setting. The frontend receives this config via the `/api/status` endpoint.

### Backend Usage
Use the `logger` singleton from `src/core/logger.ts`:
```typescript
import { logger } from '../core/logger';

logger.info('System initializing...');
logger.debug('Payload received:', payload);
```

### Frontend Usage
**Do not use `console.log` directly.** Use the frontend `logger` from `src/app/ui/logger.ts`:
```typescript
import { logger } from '@/app/ui/logger';

logger.info('Component mounted');
logger.debug('State updated:', newState);
```
Logs below the configured level will be suppressed in the browser console.

## Development Workflow

1.  **Refactoring Components**: When refactoring, ensure you split large components into smaller files within your module's directory.
2.  **Styling**: Use Tailwind CSS for styling.
3.  **Testing**: Verify your changes against a live Foundry instance running the target system.
4.  **Common Utilities**: Use `src/modules/core/utils.ts` for common helpers like `resolveImage` and `processHtmlContent` to ensure consistency.

### Asset Resolution

To ensure assets (images, icons) load correctly from the Foundry server, do not use direct path concatenation or hardcoded URLs.

1.  **Centralized Resolution**: Use the `resolveImageUrl` helper from the `ConfigContext`.
2.  **Hook Usage**: All module UI components should consume this via the `useConfig()` hook:
    ```tsx
    const { resolveImageUrl } = useConfig();
    // ...
    <img src={resolveImageUrl(item.img)} />
    ```
3.  **Avoid Manual Resolve**: Do not manually pass `foundryUrl` to the `resolveImage` utility unless working outside the React component tree.

## Reusable UI Components

We provide several core UI components (RichTextEditor, Toast, Modal, DiceTray) to ensure a consistent UI.
For detailed documentation and usage examples, see [docs/UI.md](docs/UI.md).

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
