# Contributing to SheetDelver

Welcome to **SheetDelver**! We appreciate your interest in contributing to this extensible character sheet manager.

## Getting Started

### Prerequisites
- Node.js 22.12+
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
- `src/modules`: Module registry, lifecycle, distribution, and loading infrastructure.
- `src/scripts/tools`: **Admin Tools**. Scripts for world management and direct imports.
- `src/scripts`: Tooling, build scripts, and the unified startup manager.
- `src/tests`: Automated unit and integration tests.

## Module Architecture

Each RPG system is a **self-contained external module** discovered at runtime from the data directory. Modules live in `<DATA_DIR>/local/modules/<id>/` (local dev, Mode A source) or `<DATA_DIR>/modules/<id>/` (managed install, Mode B artifact). The data directory defaults to `./data/` and is configured via `--data-dir=<path>` or the `SHEET_DELVER_DATA` environment variable.

The registry (`src/modules/registry/core/server.ts`) scans these directories at startup — no manual registration is needed.

*   **SDK import surface**: All platform APIs are accessed via the `@sheet-delver/sdk` entry-point family. Use `@sheet-delver/sdk` for shared adapter/types/utilities, `@sheet-delver/sdk/react` for client hooks, and `@sheet-delver/sdk/server` for route/runtime types. Do not import from `@core/*`, `@server/*`, `@client/*`, or `@modules/*` internal aliases.
*   **Isolation**: Do not import code from other system modules.
*   **Adapter contract**: Extend `BaseSystemAdapter` from `@sheet-delver/sdk`. Override only the methods you need — defaults are provided for everything.
*   **Context injection**: The platform wraps every module component in `SDKProvider`, which injects contexts and shared components via `useSDK()` and `useSDKComponents()` from `@sheet-delver/sdk/react`.
*   **Shared components**: Access platform UI components (`LoadingModal`, `RollDialog`, `ConfirmationModal`, `RichTextEditor`, `SharedContentModal`) via `useSDKComponents()` — do not import them from `@client/ui/components/` directly.

See `docs/MODULE_MANIFEST.md` for the full authoring reference including SDK surface, module runtime services, compendium pack configuration, and build setup.
For the shorter end-to-end workflow, see [Module Authoring Guide](MODULE_AUTHORING.md).

## Adding a New System

Use the scaffolded module workflow:

```bash
npm run module:init my-system "My System"
npm run module:check my-system
```

Pass `--data-dir` when working outside the default `./data` directory. The generated module is discovered automatically from `<DATA_DIR>/local/modules/<module-id>/`; no registry edits are required.

The [Module Authoring Guide](MODULE_AUTHORING.md) covers the end-to-end development path. The manifest reference in `MODULE_MANIFEST.md` remains the authoritative contract for metadata, entry points, SDK hooks, compendium packs, and server routes.

## Packaging a Module for Distribution

Once the module passes `module:check`, create a distributable artifact with:

```bash
npm run module:package <module-id>
```

Use `-- --data-dir <path>` when packaging from a non-default data directory. The packaging tool writes its archive and integrity hash under the configured data directory; the authoring guide covers the expected workflow in more detail.

## Module API & Server-Side Logic

Modules can define server-side API handlers that are automatically routed via `/api/modules/<systemId>/<route>`.
For details on implementing module APIs, see [docs/API.md](docs/API.md).

## Data Persistence & Caching

SheetDelver uses a persistent cache to store metadata and improve resolution reliability.

*   **Setup Scraper Cache**: Discovery data for worlds and users is stored in `.sheet-delver/cache.json`.
*   **Compendium Pack Rows**: Module-declared packs are indexed or hydrated locally before module initialization. Hydrated pack rows are the normal source for compendium `fetchByUuid` reads.
*   **Primary Documents**: Long-lived Foundry primary document caches live under `src/server/core/documents/primary/`. Actor caching is implemented by `ActorStore` and seeded by `seedDocumentCache()` during bootstrap. New primary document types should follow that structure instead of adding one-off socket-local caches.

### High-Reliability Resolution: `fetchByUuid`

To ensure system-critical data (like spell descriptions) loads from predictable platform-owned sources:

1.  **Compendium Pack Rows**: Declared compendium packs are indexed or hydrated during bootstrap. A compendium UUID read requires a declared pack with `hydrate: true`.
2.  **Cache-Required Misses**: If a compendium document is not present in declared hydrated pack rows, `fetchByUuid` returns `null` and logs a warning. Fix the module's `compendiumPacks` declaration instead of depending on a live Foundry lookup.
3.  **Diagnostic Fallback**: Operators may temporarily enable `foundry.allow-live-compendium-uuid-fallback` or `APP_ALLOW_LIVE_COMPENDIUM_UUID_FALLBACK=true` to permit a live pack-document fetch. Do not rely on this in module code or tests.
4.  **Actor Cache**: Actor API routes should read hydrated actors from `ActorStore`; use UUID fetches only for linked references that are not already embedded in the actor.

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
Use the platform logger:
```typescript
import { logger } from '@shared/utils/logger';

logger.info('System initializing...');
logger.debug('Payload received:', payload);
```

### Frontend Usage
**Do not use `console.log` directly.** Use the shared logger in host UI code:
```typescript
import { logger } from '@shared/utils/logger';

logger.info('Component mounted');
logger.debug('State updated:', newState);
```
Logs below the configured level will be suppressed in the browser console.

## Development Workflow

1.  **Refactoring Components**: When refactoring, split large components into smaller files near their feature area.
2.  **Styling**: Use Tailwind CSS for styling.
3.  **Testing**: Verify your changes against a live Foundry instance running the target system.
4.  **Common Utilities**: Use shared SDK or platform utilities instead of duplicating image, HTML, dice, or document helpers.

### Asset Resolution

To ensure assets (images, icons) load correctly from the Foundry server, do not use direct path concatenation or hardcoded URLs.

1.  **Host UI**: Use existing host URL helpers rather than string concatenation.
2.  **Module UI**: Use `useSDK().resolveImageUrl()` for Foundry images and `useSDK().assetUrl()` for module assets:
    ```tsx
    const { resolveImageUrl, assetUrl } = useSDK();

    <img src={resolveImageUrl(actor.img)} />
    <img src={assetUrl('images/icon.png')} />
    ```
3.  **Avoid Manual Resolve**: Do not manually pass `foundryUrl` around inside React surfaces.

## Reusable UI Components

We provide several core UI components (RichTextEditor, Toast, Modal, DiceTray) to ensure a consistent UI.
For detailed documentation and usage examples, see [docs/UI.md](docs/UI.md).

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
