# Module Manifest & Directory Structure

All system-specific modules in `src/modules/` MUST adhere to this standardized architecture to ensure clean domain separation, build-time safety, and registry compatibility.

## 1. Directory Blueprint

```text
module-dir/
├── info.json          # Module metadata & manifest pointers
├── module/            # PUBLIC entry points (Thin re-exports)
│   ├── ui.tsx         # Browser-safe UI manifest
│   ├── logic.ts       # Server-side logic/adapter re-export
│   └── server.ts      # Server-side API/handler re-export
└── src/               # PRIVATE implementation
    ├── ui/            # React components & themes
    ├── logic/         # System Adapter & rule evaluations
    ├── server/        # Specialized API handlers & importers
    └── data/          # In-memory caches & managers
```

## 2. Entry Point Definitions

### `module/ui.tsx` (Frontend)
Must export a `UIModuleManifest` as the **default export**. This file must be **browser-safe** and uses `React.lazy` for component imports to ensure small bundle sizes.
- **Path in info.json**: `manifest.ui`

### `module/logic.ts` (Shared/Server Logic)
Must export the `SystemAdapter` implementation as a named export `Adapter`. This is a strict requirement for the `registry` to resolve character sheet logic and calculations.
- **Path in info.json**: `manifest.logic`
- **Note**: If you point `manifest.logic` directly to a class file (e.g., `src/server/MyAdapter.ts`), that file must include `export { MyAdapter as Adapter };` at the bottom to maintain compatibility.

### `module/server.ts` (Server-Only Handlers)
Optional. Re-exports API initialization or specialized server-only logic (e.g., importers). Explicitly gated by the core registry to prevent Node.js leaks into the browser.
- **Path in info.json**: `manifest.server`

## 3. Manifest Configuration (`info.json`)

```json
{
    "id": "my-system-id",
    "title": "My Awesome RPG",
    "aliases": ["my-system"],
    "experimental": false,
    "trust": {
        "tier": "first-party"
    },
    "compatibility": {
        "coreVersion": ">=0.7.0 <1.0.0",
        "apiContracts": {
            "module-api": ">=1.0.0 <2.0.0",
            "ui-extension-api": ">=1.0.0 <2.0.0",
            "roll-engine-api": ">=1.0.0 <2.0.0"
        }
    },
    "manifest": {
        "ui": "module/ui",
        "logic": "module/logic",
        "server": "module/server"
    },
    "permissions": {
        "network": {
            "outbound": false,
            "allowHosts": []
        },
        "filesystem": {
            "read": ["moduleData"],
            "write": ["moduleData"]
        },
        "adminRoutes": false,
        "sensitiveData": ["actor"]
    },
    "dependencies": ["generic"],
    "conflicts": ["legacy-system"],
    "discovery": {
        "packs": [
            { "id": "system.items", "type": "Item", "hydrate": true },
            { "id": "system.tables", "type": "RollTable", "hydrate": false }
        ]
    }
}
```

### Currently Recognized Manifest Fields

- **`id`**: Required non-empty module ID.
- **`title`**: Required display title.
- **`aliases`**: Optional alternate identifiers.
- **`experimental`**: Optional flag that hides the module from normal public listing.
- **`trust.tier`**: Optional trust tier used by manager policy. Allowed values:
    - `first-party`
    - `verified-third-party`
    - `unverified`
- **`compatibility.coreVersion`**: Optional semver constraint checked during validation.
- **`compatibility.apiContracts`**: Optional contract range map enforced during validate/install/upgrade compatibility checks.
- **`manifest.ui` / `manifest.logic`**: Required entrypoints.
- **`manifest.server`**: Optional server-only entrypoint.
- **`permissions`**: Optional requested capability declarations evaluated by manager policy.
- **`dependencies`**: Optional required module IDs.
- **`conflicts`**: Optional mutually exclusive module IDs.
- **`discovery`**: Optional compendium sync metadata.

### Permission Declaration Baseline

The current manager recognizes these optional permission fields:

- **`permissions.network.outbound`**: Boolean; request outbound network access.
- **`permissions.network.allowHosts`**: Optional string array of allowed hostnames.
- **`permissions.filesystem.read`**: Optional string array of read scopes.
- **`permissions.filesystem.write`**: Optional string array of write scopes.
- **`permissions.adminRoutes`**: Boolean; request admin-route integration.
- **`permissions.sensitiveData`**: Optional string array describing sensitive data categories accessed.

During upgrade, newly requested permissions may require explicit admin approval before the operation is allowed.

### Trust and Verification Notes

- Missing `trust` metadata currently defaults to first-party behavior for backward compatibility with existing in-repo modules.
- Local install sources (`local://`, `file://`) are allowed without digest/signature enforcement and are recorded as verification `skipped`.
- Non-local install/upgrade sources are expected to provide integrity and signature metadata for manager verification.

### Contract Compatibility Migration (First-Party Modules)

Phase 25 requires explicit contract range declarations for first-party modules.

Migration checklist:

1. Add `compatibility.apiContracts` to `info.json`.
2. Declare every contract the module depends on (`module-api`, `ui-extension-api`, `roll-engine-api` as applicable).
3. Use supported range tokens (`=`, `>`, `>=`, `<`, `<=`) with space-separated constraints.
4. Verify module validate/install/upgrade flows after declaration updates.

Baseline declaration currently used by in-repo first-party modules:

```json
"compatibility": {
    "apiContracts": {
        "module-api": ">=1.0.0 <2.0.0",
        "ui-extension-api": ">=1.0.0 <2.0.0",
        "roll-engine-api": ">=1.0.0 <2.0.0"
    }
}
```

## 4. Discovery & Data Persistence

The Core Discovery Service automatically synchronizes, hashes, and shards compendium data based on the `discovery` block in `info.json`.

### `PackDiscoveryConfig`
- **`id`**: The Foundry compendium ID (e.g., `shadowdark.classes`).
- **`type`**: The document type (`Item`, `Actor`, `JournalEntry`, `Scene`, `Macro`, or `RollTable`).
- **`hydrate`**: 
    - `true`: Performs a deep fetch of every document in the pack using the "Index-then-Hydrate" strategy. Use this for character-building data (Classes, Backgrounds) to ensure full descriptions are available.
    - `false`: Performs a lightweight indexed fetch. Ideal for large item or spell libraries where you only need names and basic metadata.
- **`fields`**: (Optional) Specific fields to index when `hydrate` is `false`.

### Sharded Caching
Data is stored at `.data/cache/[systemId]/pack-[id].json`. A `manifest-[systemId].json` tracks MD5 signatures for each shard, ensuring that data is only re-synchronized when it actually changes on the Foundry server.

## 5. Key Rules
1. **No Root Logic**: Do not place logic, adapters, or components in the module root.
2. **Import Hygiene**: The `module/` directory acts as a firewall. Internal `src/` files should use relative paths to other `src/` subdirectories.
3. **Automated Discovery**: New systems are **automatically discovered** on server boot if they follow this manifest structure.
4. **Manager Policy Compatibility**: If you declare remote-distribution or elevated permissions, keep `trust`, `permissions`, `dependencies`, and `conflicts` accurate so manager operations can evaluate policy correctly.
5. **Registry Architecture**: Strictly follow the "Zero `index.ts`" policy for the registry.
   - Server: `@modules/registry/server`
   - Client: `@modules/registry/client`
   - Shared Types: `@modules/registry/types`
