<img src="logo.png" width="25%" alt="SheetDelver Logo">

[![GitHub Repo](https://img.shields.io/badge/github-repo-blue?logo=github)](https://github.com/sheetdelver/sheetdelver)
[![CI](https://github.com/sheetdelver/sheetdelver/actions/workflows/ci.yml/badge.svg)](https://github.com/sheetdelver/sheetdelver/actions/workflows/ci.yml)

A modern, external character sheet interface for [Foundry VTT](https://foundryvtt.com/).

## Key Features
- **Character Sheets**: Custom designed sheets by system, see below for supported systems.
- **Real-Time Interactions**: Instant display of images and journals shared by the GM ("Show to Players"), with support for both broadcast and targeted sharing.
- **Rich Journal Browser**: Advanced journal viewing with folder support, rich text rendering, and pagination.
- **Mobile Friendly**: Optimized touch targets and responsive layouts.

## Commonly Shared Features
- **Dashboard**: Initial view and shared amongst all supported systems. It will display a users owned actors and additional tools (if implemented) such as for creating or importing characters.
- **Chat**: A common chat interface for all systems. It will display a users chat messages and allow them to send messages to the GM. It will also display a list of active players and their connection status.
- **Dice Roller**: Universal dice roller modeled after the dice tray module for Foundry VTT. 
- **Combat Tracker**: Combat tracker HUD that displays at top whenever the system detects an active combat. It allows for rolling initiative and ending turn.

<img src="images/dashboard.png" width="25%">

## Supported Systems

### Shadowdark RPG
While not yet feature-complete, SheetDelver offers robust support for Shadowdark.
See module in its own repository [![Here]](https://github.com/sheetdelver/sd-shadowdark)
<img src="images/sheets/shadowdark/sd-character-sheet.png" width="25%">
<img src="images/sheets/shadowdark/sd-paper-view.png" width="25%">

### Mörk Borg
SheetDelver provides support for the Mörk Borg RPG system:
See module in its own repository [![Here]](https://github.com/sheetdelver/sd-morkborg)
<img src="images/sheets/morkborg/mb-character-sheet.png" width="25%">

### D&D 5th Edition *(experimental)*
Early support for D&D 5e is in active development. The module is installable but not yet feature-complete.
See module in its own repository [![Here]](https://github.com/sheetdelver/sd-dnd5e)

## Planned System Support
- **PF2E**: Planned...

## Architecture
SheetDelver follows a **Hardened 4-Folder Root** architecture with a strict **Logic Firewall**:

1.  **Client Shell** (`src/client` | `@client`): A pure frontend environment (Next.js/React). Strictly forbidden from importing Node.js globals.
2.  **Server Core** (`src/server` | `@server`, `@core`): A dedicated Express API and Foundry socket bridge. Manages per-user session proxying.
3.  **Shared Layer** (`src/shared` | `@shared`): Environment-agnostic interfaces, constants, and pure utilities safe for both browser and server.
4.  **System Modules** (`src/modules` | `@modules`): Pluggable RPG system logic. Each module enforces its own internal client/server isolation.
5.  **Execution App** (`src/app` | `@app`): The Next.js App Router entry point.
6.  **Admin Tools** (`src/scripts/tools`): Scripts for world management and setup.

---

## Usage

### Requirements
- **Node.js**: 18+
- **Foundry VTT**: Valid instance (v13+ recommended)

### Configuration
SheetDelver stores all runtime data (configuration, cache, credentials, module state, logs) in a **data directory**.

#### Data Directory Resolution

The data directory is resolved at startup in this order:

1. `--data-dir=/path` CLI argument
2. `SHEET_DELVER_DATA` environment variable (or `DATA_DIR` / `USER_DATA`)
3. `./data/` (relative to CWD — development default)
4. `~/.sheet-delver/` (home directory)

If none exist, `./data/` is created automatically.

#### Data Directory Structure

```
data/
├── config/
│   └── settings.yaml          # Application configuration
├── cache/                      # Persistent cache (worlds, sessions)
├── security/                   # Admin credentials and audit log
├── modules/                    # Module lifecycle state and artifacts
└── logs/                       # Application logs (future use)
```

#### settings.yaml

The main configuration file lives at `<DATA_DIR>/config/settings.yaml`.

```yaml
# settings.yaml
app:
    host: localhost      # Hostname for the SheetDelver application
    port: 3000           # Port for SheetDelver to listen on
    protocol: http       # Protocol for SheetDelver (http/https)
    chat-history: 100    # Max number of chat messages to retain/display

foundry:
    host: foundryserver.local # Hostname of your Foundry VTT instance
    port: 30000               # Port of your Foundry VTT instance
    protocol: http            # Protocol (http/https)
    connector: socket         # 'socket' (Headless Sockets)
    username: "gamemaster"    # Required for Headless connection
    password: "password"      # Required for Headless connection
    # Optional diagnostic escape hatch. Keep false for normal module/SDK reads:
    # compendium UUIDs should resolve from declared hydrated compendium pack rows.
    allow-live-compendium-uuid-fallback: false
    # Optional: Path to Foundry Data directory for direct world import
    # foundryDataDirectory: "/path/to/foundryuserdata"

debug:
    enabled: true        # Enable debug logging
    level: 3             # Log level (0=None, 1=Error, 2=Warn, 3=Info, 4=Debug)

security:
    rate-limit:
        enabled: true           # Enable/disable login rate limiting
        window-minutes: 15      # Time window in minutes
        max-attempts: 5         # Maximum login attempts per window
    body-limit: 10mb            # Maximum JSON request body size (for large character imports)
    cors:
        allow-all-origins: false
        allowed-origins:
            - http://localhost:3000
    service-token: "replace-with-strong-random-token"  # Internal privileged bearer token (not a Foundry password)
    admin-setup-token: "replace-with-strong-random-bootstrap-token"  # One-time token for creating the initial /admin account
    source-governance:
        host-allowlist:      # Optional: List of allowed remote source hostnames
            - github.com
            - raw.githubusercontent.com
```

The `security.source-governance.host-allowlist` is **optional**. If empty or omitted, the system defaults to "Allow All" (Fail-Open). In production mode, requests to hosts not in this list will be blocked. In development mode, a warning will be logged instead. Wildcards are supported (e.g., `*.github.com`).


The `security.service-token` value is used only for internal privileged API bearer flows. Do not reuse your Foundry account password.

The `security.admin-setup-token` value is used only for first-time admin bootstrap at `/admin`. It is not the admin password. You choose this token, then enter it once in the admin setup form along with the password you want to create.

You can generate a strong token with either command:

```bash
openssl rand -hex 32
```

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Environment override is supported via `APP_SERVICE_TOKEN`.

Environment override is also supported via `APP_ADMIN_SETUP_TOKEN`.

Live compendium UUID fallback is disabled by default. Module and SDK `fetchByUuid` calls resolve compendium documents from declared hydrated compendium pack rows; a miss logs a warning and returns `null` so module authors can fix their `info.json` pack declarations. For diagnostics only, set `foundry.allow-live-compendium-uuid-fallback: true`, `foundry.allowLiveCompendiumUuidFallback: true`, or `APP_ALLOW_LIVE_COMPENDIUM_UUID_FALLBACK=true` to allow a live Foundry pack-document fetch.

CORS policy is allow-list based by default and shared by Express + Socket.io:
- `security.cors.allowed-origins` controls allowed origins.
- `security.cors.allow-all-origins` enables explicit permissive mode when set to `true`.
- Environment overrides:
    - `APP_CORS_ALLOWED_ORIGINS` as a comma-separated list (for example `https://app.example.com,https://admin.example.com`)
    - `APP_CORS_ALLOW_ALL_ORIGINS=true|false`

Debug API surface follows the existing debug switch:
- `debug.enabled: true` enables debug routes.
- `debug.enabled: false` disables debug routes (recommended outside active debug sessions).

### Running Locally
1.  **Install Dependencies**:
    ```bash
    npm install
    ```
2.  **Run Setup Wizard**:
    ```bash
    npm run setup                         # Uses default ./data/
    npm run setup -- --data-dir=/custom   # Custom data directory
    ```
    *Follow the prompts to configure your Foundry connection. The setup wizard auto-generates both `security.service-token` and `security.admin-setup-token` in `settings.yaml`, stored at `<DATA_DIR>/config/settings.yaml`.*

3.  **Start the Application**:
    -   **Development**:
        ```bash
        npm run dev                              # Uses default ./data/
        npm run dev -- --data-dir=/custom         # Custom data directory
        SHEET_DELVER_DATA=/custom npm run dev     # Via environment variable
        ```
    -   **Production**:
        ```bash
        npm run build && npm start
        ```

4.  **Create the Admin Account**:
    Open `/admin` after the app starts. On first run you will see the setup form instead of the login form.
    Enter:
    - the value from `security.admin-setup-token` (or `APP_ADMIN_SETUP_TOKEN`)
    - the admin password you want to create

5.  **Deployment (PM2)**:
    For production environments, use [PM2](https://pm2.keymetrics.io/) with the provided ecosystem file to ensure the application runs from the correct directory.

    ```bash
    # Install PM2 globally
    npm install -g pm2

    # Start the application using the ecosystem config
    pm2 start ecosystem.config.cjs

    # (Optional) Enable startup on boot
    pm2 startup
    pm2 save
    ```

    Configure the data directory in `ecosystem.config.cjs` via the `SHEET_DELVER_DATA` environment variable.

6.  **Open**: Navigate to the URL shown in the setup output (typically [http://localhost:3000](http://localhost:3000)).

*Note: The startup process automatically manages both the backend service and the frontend web server.*

### Testing

```bash
npm run test:unit     # full unit suite
npm run test:client   # client/browser-helper slice
npm run test:integration
npm run test:socket   # live Foundry socket suite; requires configured Foundry
```

### Migrating from Previous Versions

If upgrading from a version that used `.data/` in the project root and `settings.yaml` at the CWD:

```bash
# 1. Create the new data directory structure
mkdir -p data/{config,cache,security,modules,logs}

# 2. Move configuration
mv settings.yaml data/config/

# 3. Move persistent data
mv .data/cache/* data/cache/
mv .data/security/* data/security/
mv .data/modules/* data/modules/

# 4. Remove legacy paths
rm -rf .data/
rm -f .foundry-cache.json .foundry-session.json
```

The application will warn if legacy paths are detected at startup.

### Admin Utilities
SheetDelver includes an admin tool for importing world data directly.

- **Direct Import**: `npm run admin:import <path>`
  - **Smart Discovery**:
    - If `<path>` is a **Data Directory** (e.g. `FoundryVTT/Data`), it imports **ALL** worlds found within.
    - If `<path>` is a **World Directory** (e.g. `FoundryVTT/Data/worlds/my-world`), it imports **only that world**.
  - *Example*: `npm run admin:import /home/user/.local/share/FoundryVTT/Data`

## Development
For developers interested in contributing to **SheetDelver**, please refer to [CONTRIBUTING.md](docs/CONTRIBUTING.md) for detailed setup instructions, architecture overview, and guidelines.

## License

This project is licensed under the MIT License.

### Third-Party Licenses

**Shadowdark RPG**
This product is an independent product published under the Shadowdark RPG Third-Party License and is not affiliated with The Arcane Library, LLC. Shadowdark RPG © 2023 The Arcane Library, LLC.

**foundryvtt-shadowdark**
Partial code and data utilized from the [foundryvtt-shadowdark](https://github.com/Muttley/foundryvtt-shadowdark) system, licensed under the MIT License. Copyright (c) 2023 Paul Maskelyne.

**Mörk Borg RPG**
Mörk Borg is copyright Ockult Örtmästare Games and Stockholm Kartell. This product is an independent production by SheetDelver and is not affiliated with Ockult Örtmästare Games or Stockholm Kartell. It is published under the [MÖRK BORG THIRD PARTY LICENSE](https://morkborg.com/license/).

**foundryvtt-morkborg**
Partial code and data reference utilized from the [foundryvtt-morkborg](https://github.com/fvtt-fria-ligan/morkborg-foundry) system, licensed under the MIT License. Copyright (c) fvtt-fria-ligan contributors.
