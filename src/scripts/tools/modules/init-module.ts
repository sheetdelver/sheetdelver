import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveDataDir, getDataDir, getLocalModulesDataDir } from '../../../server/core/paths';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Template content for the module's info.json file, with placeholders for system ID and name
const MODULE_INFO_JSON = `{
  "id": "%SYSTEM_ID%",
  "version": "1.0.0",
  "title": "%SYSTEM_NAME%",
  "experimental": false,
  "manifest": {
    "ui": "module/ui",
    "logic": "module/logic",
    "server": "module/server"
  },
  "compatibility": {
    "apiContracts": {
      "module-api": ">=1.0.0 <2.0.0",
      "ui-extension-api": ">=1.0.0 <2.0.0",
      "roll-engine-api": ">=1.0.0 <2.0.0"
    }
  },
  "compendiumPacks": {
    "packs": [
      { "id": "%SYSTEM_ID%.items", "type": "Item", "hydrate": true },
      { "id": "%SYSTEM_ID%.spells", "type": "Item", "hydrate": false }
    ]
  },
  "trust": { "tier": "first-party" },
  "package": {
    "include": []
  },
  "aliases": ["%SYSTEM_ID%"],
  "dependencies": [],
  "conflicts": []
}
`;

// Template content for the module's README.md file, with placeholders for system ID and name
const MODULE_README = `# %SYSTEM_NAME% Module: %SYSTEM_ID%

This module is designed for the %SYSTEM_NAME% system. It includes basic scaffolding for UI, logic, and server components.

## Directory Structure

- \`module/\`: Place any static assets or resources here.
- \`src/logic/\`: Implement your module's logic and data transformations here.
- \`src/ui/\`: Create React components for your module's user interface here.

## Getting Started

1. Implement your module's logic in the \`src/logic/\` directory.
2. Build your UI components in the \`src/ui/\` directory.
3. Use the provided APIs to integrate with the Sheet Delver system.

Refer to the [Sheet Delver Module Manifest documentation](https://github.com/sheetdelver/sheet-delver/blob/main/src/modules/MODULE_MANIFEST.md) for detailed API usage and examples.

Happy developing!
`

/** 
 * GitHub Actions workflow template for building and publishing the module on push to main or manual trigger
 * Checks out sheet-delver, sets up Node.js, installs dependencies, builds the module, and publishes it.
 * The %SYSTEM_ID% placeholder is replaced with the actual system ID of the module at init time.
 * This workflow should be saved as .github/workflows/ci-%SYSTEM_ID%.yaml in the module repository.
 *
 * Two-checkout strategy:
 *   1. sheetdelver/sheet-delver → ./ (the platform with build scripts and module registry)
 *   2. This module repo → ${SHEET_DELVER_DATA}/local/modules/%SYSTEM_ID%/ (where the platform expects to find it)
 *
 * paths: trigger on files that actually exist in the module repo root,
 *        NOT the platform-relative local module path, which never matches.
*/
const GITHUB_ACTIONS_WORKFLOW = `name: Build Module

on:
  push:
    branches:
      - main
    paths:
      - 'src/**'
      - 'module/**'
      - 'info.json'
      - 'package.json'
  pull_request:
    branches:
      - main
    paths:
      - 'src/**'
      - 'module/**'
      - 'info.json'
      - 'package.json'
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    env:
      SHEET_DELVER_DATA: ./data
    defaults:
      run:
        working-directory: ./
    steps:
      # Checkout the Sheet Delver platform into the workspace root
      - name: Checkout Sheet Delver Repository
        uses: actions/checkout@v3
        with:
          repository: sheetdelver/sheet-delver
          path: ./

      # Checkout this module into the platform's local modules data directory
      - name: Checkout %SYSTEM_ID% Module
        uses: actions/checkout@v3
        with:
          repository: \${{ github.repository }}
          path: \${{ env.SHEET_DELVER_DATA }}/local/modules/%SYSTEM_ID%

      - name: Set up Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '22'

      - name: Install dependencies
        run: npm install

      - name: Generate config
        run: |
          cat > settings.yaml << EOF
          app:
              host: localhost
              port: 3000
              api-port: 3001
              protocol: http
              chat-history: 100
          foundry:
              host: localhost
              port: 30000
              protocol: http
              connector: socket
              username: gamemaster
              password: gamemaster
              allow-live-compendium-uuid-fallback: false
              foundryDataDirectory: foundryData
          debug:
              enabled: true
              level: 3
          EOF

      - name: Build module
        run: npm run build
`;

// tsconfig.json for the module — extends the platform's managed path aliases
// so that @sheet-delver/sdk and module path mappings resolve correctly in both
// the editor and during the platform build.
function createModuleTsconfig(modulePath: string): string {
  const managedTsconfig = path.relative(modulePath, path.join(process.cwd(), '.managed', 'tsconfig.paths.json')).replace(/\\/g, '/');
  return `{
  "extends": "${managedTsconfig}",
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "resolveJsonModule": true
  },
  "include": ["module/**/*", "src/**/*"]
}
`;
}

function toTypeScriptIdentifier(value: string): string {
  const words = value.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const name = words
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join('');
  const identifier = name || 'Module';
  return /^[A-Za-z_$]/.test(identifier) ? identifier : `Module${identifier}`;
}

// Template content for logic.ts import file
const LOGIC_TS_IMPORT = `export { %SYSTEM_ID%Adapter as Adapter } from '../src/logic/adapter';`;

// Template content for adapter.ts file
const LOGIC_TS = `import {
    BaseSystemAdapter,
    type FoundryActor,
    type ActorSheetData,
} from '@sheet-delver/sdk';

export class %SYSTEM_ID%Adapter extends BaseSystemAdapter {
    systemId = '%MODULE_ID%';

    match(actor: FoundryActor): boolean {
        return actor._stats?.systemId === this.systemId;
    }

    normalizeActorData(actor: FoundryActor): ActorSheetData {
        return {
            id: actor._id,
            name: actor.name,
            type: actor.type,
            img: actor.img ?? '',
            system: actor.system ?? {},
            items: actor.items ?? [],
            effects: actor.effects ?? [],
            derived: {},
        };
    }
}
`;

// Template content for ui.tsx file
const UI_TSX = `import type { ModuleInfo, UIModuleManifest } from '@sheet-delver/sdk';
import infoJson from '../info.json';

const info = infoJson as ModuleInfo;

const uiManifest: UIModuleManifest = {
    info,
    sheet: () => import('../src/ui/Sheet'),
    actorPage: () => import('../src/ui/ActorPage'),
    stylesheet: 'assets/styles.css',
};

export default uiManifest;
`;

const UI_SHEET_TSX = `import React from 'react';

export default function Sheet() {
    return (
        <div>
            <h1>Sheet Component</h1>
            <p>This is the character sheet UI for the module.</p>
        </div>
    );
}
`;

const UI_ACTOR_PAGE_TSX = `import React from 'react';

export default function ActorPage() {
    return (
        <div>
            <h1>Actor Page Component</h1>
            <p>This is the actor page UI for the module.</p>
        </div>
    );
}
`;

// Template content for server.ts import file
const SERVER_TS_IMPORT = `export { apiRoutes } from '../src/server/server';
`;

// Template content for server.ts file
const SERVER_TS = `import type { ModuleServerExport, ModuleServerRequest, ModuleServerParams } from '@sheet-delver/sdk';
import { getErrorMessage } from '@sheet-delver/sdk';

async function addCustomItemToActor(req: ModuleServerRequest, params: ModuleServerParams) {
    try {
        const { route } = await params.params;
        const actorId = route[1];
        const itemData = await req.json<Record<string, unknown>>();

        if (!actorId) {
            return { status: 400, json: async () => ({ error: 'Missing actor id' }) };
        }

        // Document ops live on req.runtime and default to the calling user (req.userSession).
        const item = await req.runtime.documents.create('item', { ...itemData, actorId });
        return { status: 200, json: async () => ({ success: true, item }) };
    } catch (error) {
        return { status: 500, json: async () => ({ error: getErrorMessage(error) }) };
    }
}

export const apiRoutes: ModuleServerExport['apiRoutes'] = {
    'actor/[id]/addItem': addCustomItemToActor,
};
`;

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Initializes a new module directory with the given module ID.
 *
 * @param moduleId - The unique identifier for the new module (e.g., "my-module")
 * @param systemName - The name of the system this module is for (e.g., "My RPG System")
 * @throws Error if the module directory already exists
 */
export function initModule(moduleId: string, systemName: string): void {
  let modulePath = path.join(getLocalModulesDataDir(), moduleId);
  const classPrefix = toTypeScriptIdentifier(moduleId);

  // Check if module path exists, if it does already exist, throw an error to avoid overwriting
  if (fs.existsSync(modulePath)) {
    throw new Error(`Module path ${modulePath} already exists. Choose a different name or remove the existing module.`);
  }

  console.log(`Initializing module "${moduleId}" for system "${systemName}" at ${modulePath}...`);

  fs.mkdirSync(modulePath, { recursive: true });

  // Create empty .github/workflows, module, logic, ui, server and assets directories
  fs.mkdirSync(path.join(modulePath, '.github', 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(modulePath, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(modulePath, 'module'), { recursive: true });
  fs.mkdirSync(path.join(modulePath, 'src', 'logic'), { recursive: true });
  fs.mkdirSync(path.join(modulePath, 'src', 'ui'), { recursive: true });
  fs.mkdirSync(path.join(modulePath, 'src', 'server'), { recursive: true });

  console.log(`Created module directory structure at ${modulePath}`);

  // Create starter stylesheet
  fs.writeFileSync(
      path.join(modulePath, 'assets', 'styles.css'),
      `/* ${systemName} — module stylesheet */\n`,
      'utf8'
  );
  console.log('Created assets/styles.css');

  // Create info.json with template content
  const infoContent = MODULE_INFO_JSON.replace(/%SYSTEM_ID%/g, moduleId).replace(/%SYSTEM_NAME%/g, systemName);
  fs.writeFileSync(path.join(modulePath, 'info.json'), infoContent, 'utf8');

  console.log(`Module "${moduleId}" initialized successfully at ${modulePath}`);

  // Create tsconfig.json so the editor and build tools resolve SDK path aliases
  fs.writeFileSync(path.join(modulePath, 'tsconfig.json'), createModuleTsconfig(modulePath), 'utf8');
  console.log(`Created tsconfig.json for module "${moduleId}".`);

  // Create a README.md with basic instructions
  const readmeContent = MODULE_README.replace(/%SYSTEM_ID%/g, moduleId).replace(/%SYSTEM_NAME%/g, systemName);
  fs.writeFileSync(path.join(modulePath, 'README.md'), readmeContent, 'utf8');

  console.log(`Created README.md for module "${moduleId}" with basic instructions.`);

  // Create github workflow actions file for building and publishing the module on push to main or manual trigger
  const workflowContent = GITHUB_ACTIONS_WORKFLOW.replace(/%SYSTEM_ID%/g, moduleId);
  const workflowDir = path.join('.github', 'workflows');
  fs.writeFileSync(path.join(modulePath, workflowDir, `ci-${moduleId}.yaml`), workflowContent, 'utf8');

  console.log(`Created GitHub Actions workflow for module "${moduleId}" at ${path.join(modulePath, workflowDir, `ci-${moduleId}.yaml`)}`);

  console.log('Creating template files for logic, UI, and server components...');
  // Create logic and adapter files with template content
  const logicImportContent = LOGIC_TS_IMPORT.replace(/%SYSTEM_ID%/g, classPrefix);
  fs.writeFileSync(path.join(modulePath, 'module', 'logic.ts'), logicImportContent, 'utf8');
  console.log('Created logic import file with template content at ' + path.join(modulePath, 'module', 'logic.ts'));
  const logicContent = LOGIC_TS
      .replace(/%SYSTEM_ID%/g, classPrefix)
      .replace(/%MODULE_ID%/g, moduleId);
  fs.writeFileSync(path.join(modulePath, 'src', 'logic', 'adapter.ts'), logicContent, 'utf8');
  console.log('Created logic files with template content at ' + path.join(modulePath, 'src', 'logic', 'adapter.ts'));

  // Create UI files with template content
  const uiContent = UI_TSX.replace(/%SYSTEM_ID%/g, classPrefix);
  fs.writeFileSync(path.join(modulePath, 'module', 'ui.tsx'), uiContent, 'utf8');
  console.log('Created UI import file with template content at ' + path.join(modulePath, 'module', 'ui.tsx'));
  fs.writeFileSync(path.join(modulePath, 'src', 'ui', 'Sheet.tsx'), UI_SHEET_TSX, 'utf8');
  console.log('Created UI Sheet component file with template content at ' + path.join(modulePath, 'src', 'ui', 'Sheet.tsx'));
  fs.writeFileSync(path.join(modulePath, 'src', 'ui', 'ActorPage.tsx'), UI_ACTOR_PAGE_TSX, 'utf8');
  console.log('Created UI ActorPage component file with template content at ' + path.join(modulePath, 'src', 'ui', 'ActorPage.tsx'));

  // Create server files with template content
  const serverImportContent = SERVER_TS_IMPORT.replace(/%SYSTEM_ID%/g, classPrefix);
  fs.writeFileSync(path.join(modulePath, 'module', 'server.ts'), serverImportContent, 'utf8');
  console.log('Created server import file with template content at ' + path.join(modulePath, 'module', 'server.ts'));
  const serverContent = SERVER_TS.replace(/%SYSTEM_ID%/g, classPrefix);
  fs.writeFileSync(path.join(modulePath, 'src', 'server', 'server.ts'), serverContent, 'utf8');
  console.log('Created server files with template content at ' + path.join(modulePath, 'src', 'server', 'server.ts'));

  console.log(`Module "${moduleId}" initialized with template files for logic, UI, and server.`);
}


// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const moduleId = process.argv[2];
  const systemName = process.argv[3] || moduleId;
  if (!moduleId || !systemName) {
    console.error('Usage: npm run module:init <moduleId> <systemName> [--data-dir <path-to-data-dir>]');
    process.exit(1);
  }

  // Data directory
  resolveDataDir(process.argv); // Ensure data directory is resolved and initialized before proceeding

  const dataDir = getDataDir();
  console.log(`Using data directory: ${dataDir}`);

  try {
    initModule(moduleId, systemName);
    console.log(`Module "${moduleId}" initialized successfully.`);
    console.log('Next steps:');
    const modulePath = path.join(dataDir, 'local', 'modules', moduleId);
    console.log(`1. Implement your module's logic in ${path.join(modulePath, 'src', 'logic')}/`);
    console.log(`2. Build your UI components in ${path.join(modulePath, 'src', 'ui')}/`);
    console.log('3. Refer to the README.md for API usage and examples.');
  } catch (error) {
    console.error(`Error initializing module: ${(error as Error).message}`);
    process.exit(1);
  }
}
