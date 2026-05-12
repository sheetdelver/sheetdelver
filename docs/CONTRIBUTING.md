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
    git clone git@github.com:sheetdelver/sheetdelver.git
    cd sheetdelver
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
- `src/scripts/tools`: **Admin Tools**. Scripts for world management and direct imports.
- `src/scripts`: Tooling, build scripts, and the unified startup manager.
- `src/tests`: Automated unit and integration tests.

## Module Architecture

Each RPG system is a **self-contained external module** discovered at runtime from the data directory. Modules live in `<DATA_DIR>/local/modules/<id>/` (local dev, Mode A source) or `<DATA_DIR>/modules/<id>/` (managed install, Mode B artifact). The data directory defaults to `./data/` and is configured via `--data-dir=<path>` or the `SHEET_DELVER_DATA` environment variable.

The registry (`src/modules/registry/core/server.ts`) scans these directories at startup — no manual registration is needed.

*   **SDK import surface**: All platform APIs are accessed via `@sheet-delver/sdk`. Do not import from `@core/*`, `@server/*`, `@client/*`, or `@modules/*` internal aliases.
*   **Isolation**: Do not import code from other system modules.
*   **Adapter contract**: Extend `BaseSystemAdapter` from `@sheet-delver/sdk`. Override only the methods you need — defaults are provided for everything.
*   **Context injection**: The platform wraps every module component in `SDKProvider`, which injects contexts and shared components via `useSDK()` and `useSDKComponents()` from `@sheet-delver/sdk`.
*   **Shared components**: Access platform UI components (`LoadingModal`, `RollDialog`, `ConfirmationModal`, `RichTextEditor`, `SharedContentModal`) via `useSDKComponents()` — do not import them from `@client/ui/components/` directly.

See `src/modules/MODULE_MANIFEST.md` for the full authoring reference including SDK surface, `ModuleFoundryClient` methods, discovery pack configuration, and build setup.

## Adding a New System

1.  **Create Directory**: Create `<DATA_DIR>/local/modules/<system-id>/` for local development.

2.  **Metadata**: Add `info.json`:
    ```json
    {
        "id": "mysystem",
        "title": "My RPG System",
        "version": "0.1.0",
        "actorCard": {
            "subtext": ["details.class", "details.ancestry", "level.value"]
        },
        "manifest": {
            "logic": "module/logic.ts",
            "ui": "module/ui.tsx"
        }
    }
    ```
    *   `actorCard.subtext`: Optional. Array of dot-notation paths to display on the dashboard character card. Defaults to actor type if omitted.
    *   `manifest.logic` / `manifest.ui`: Entry points. Use `.ts`/`.tsx` for Mode A (source), `dist/logic.js` / `dist/ui.js` for Mode B (compiled artifact).

3.  **Implement Adapter**: Create `module/logic.ts` extending `BaseSystemAdapter`:
    ```typescript
    import { BaseSystemAdapter, ModuleContext } from '@sheet-delver/sdk';

    export class MySystemAdapter extends BaseSystemAdapter {
        async initialize(context: ModuleContext) {
            // context.logger, context.platform.cache, context.platform.discovery
        }
        // Override normalizeActorData, computeActorData, categorizeItems, getRollData as needed
    }

    export default MySystemAdapter;
    ```

4.  **Create Sheet UI**: Create `module/ui.tsx` exporting a `UIModuleManifest`:
    ```typescript
    import React from 'react';
    import type { UIModuleManifest } from '@sheet-delver/sdk';
    import info from '../info.json';

    const manifest: UIModuleManifest = {
        info,
        sheet: React.lazy(() => import('./MySystemSheet')),
        actorPage: React.lazy(() => import('./pages/ActorPage')),
    };

    export default manifest;
    ```
    *   `actorPage`: Optional. Handles data fetching and layout for the character sheet page. Falls back to `GenericActorPage` if omitted.

    Inside sheet components, access platform hooks and shared UI via the SDK:
    ```typescript
    import { useSDK, useSDKComponents } from '@sheet-delver/sdk';

    function MySheet() {
        const { addNotification, fetchWithAuth, resolveImageUrl } = useSDK();
        const { LoadingModal, RollDialog } = useSDKComponents();
        // ...
    }
    ```

5.  **Register**: None needed. `npm run dev` auto-discovers the module and regenerates `data/module-ui-registry.ts`.

6.  **Dashboard Tools (Optional)**: Export a `tools` component from the `UIModuleManifest`:
    ```typescript
    const manifest: UIModuleManifest = {
        info,
        sheet: React.lazy(() => import('./MySystemSheet')),
        tools: React.lazy(() => import('./MySystemTools')),
    };
    ```

## Packaging a Module for Distribution

Once your module is working locally (Mode A source), compile it into a distributable Mode B artifact:

```bash
npm run package:module <module-id>
```

The script (`src/scripts/tools/modules/package-module.ts`) looks for the module in `<DATA_DIR>/local/modules/<module-id>/`, then:
1. Compiles each declared entry point (`logic`, `ui`, `server`) via esbuild, externalizing `@sheet-delver/sdk`, `react`, and `react-dom`.
2. Writes compiled artifacts to a staging `dist/` directory and patches `info.json` to point to the compiled paths.
3. Creates a `.tgz` archive at `<DATA_DIR>/dist/modules/<module-id>-<version>.tgz`.
4. Outputs the SHA-256 integrity hash for use in admin install payloads.

```
✅ mysystem v0.1.0 packaged successfully
   Archive : data/dist/modules/mysystem-0.1.0.tgz
   Size    : 42.3 KB
   Sha256  : sha256:abc123...
```

The archive can then be installed via the admin panel (`POST /admin/manager/:moduleId/install`) with the integrity hash as verification.

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
