import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveDataDir, getDataDir, getLocalModulesDataDir } from '../../../server/core/paths';

const TEMPLATE_SUFFIX = '.tmpl';
const TEMPLATE_TOKEN_PATTERN = /%[A-Z][A-Z0-9_]*%/g;
// The source tree mirrors generated module paths; see ./scaffolds/README.md.
const INIT_TEMPLATE_DIR = fileURLToPath(new URL('./scaffolds/init-module/', import.meta.url));

type TemplateTokens = Record<string, string>;

function toTypeScriptIdentifier(value: string): string {
  const words = value.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const name = words
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join('');
  const identifier = name || 'Module';
  return /^[A-Za-z_$]/.test(identifier) ? identifier : `Module${identifier}`;
}

function managedTsconfigPath(modulePath: string): string {
  return path.relative(modulePath, path.join(process.cwd(), '.managed', 'tsconfig.paths.json')).replace(/\\/g, '/');
}

function renderTokens(value: string, tokens: TemplateTokens, source: string): string {
  let rendered = value;
  for (const [name, replacement] of Object.entries(tokens)) {
    rendered = rendered.replaceAll(`%${name}%`, () => replacement);
  }

  const unresolved = Array.from(new Set(rendered.match(TEMPLATE_TOKEN_PATTERN) ?? []));
  if (unresolved.length > 0) {
    throw new Error(`Unresolved template token(s) in ${source}: ${unresolved.join(', ')}`);
  }
  return rendered;
}

function resolveOutputPath(modulePath: string, templateRelativePath: string, tokens: TemplateTokens): {
  relativePath: string;
  absolutePath: string;
} {
  const renderedPath = renderTokens(templateRelativePath, tokens, templateRelativePath);
  const relativePath = renderedPath.endsWith(TEMPLATE_SUFFIX)
      ? renderedPath.slice(0, -TEMPLATE_SUFFIX.length)
      : renderedPath;
  const moduleRoot = path.resolve(modulePath);
  const absolutePath = path.resolve(moduleRoot, relativePath);

  if (!absolutePath.startsWith(moduleRoot + path.sep)) {
    throw new Error(`Template output path escapes module root: ${relativePath}`);
  }
  return { relativePath, absolutePath };
}

function renderTemplateTree(modulePath: string, tokens: TemplateTokens): void {
  if (!fs.existsSync(INIT_TEMPLATE_DIR)) {
    throw new Error(`Module init template directory not found: ${INIT_TEMPLATE_DIR}`);
  }

  const visit = (sourceDir: string) => {
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const sourcePath = path.join(sourceDir, entry.name);
      const templateRelativePath = path.relative(INIT_TEMPLATE_DIR, sourcePath);
      const output = resolveOutputPath(modulePath, templateRelativePath, tokens);

      if (entry.isDirectory()) {
        fs.mkdirSync(output.absolutePath, { recursive: true });
        visit(sourcePath);
        continue;
      }
      if (!entry.isFile()) continue;

      fs.mkdirSync(path.dirname(output.absolutePath), { recursive: true });
      if (sourcePath.endsWith(TEMPLATE_SUFFIX)) {
        const source = fs.readFileSync(sourcePath, 'utf8');
        fs.writeFileSync(output.absolutePath, renderTokens(source, tokens, templateRelativePath), 'utf8');
      } else {
        fs.copyFileSync(sourcePath, output.absolutePath);
      }
      console.log(`Created ${output.relativePath}`);
    }
  };

  fs.mkdirSync(modulePath, { recursive: true });
  visit(INIT_TEMPLATE_DIR);
}

/**
 * Initializes a new module directory with the given module ID.
 *
 * @param moduleId - The unique identifier for the new module (e.g., "my-module")
 * @param systemName - The name of the system this module is for (e.g., "My RPG System")
 * @throws Error if the module directory already exists
 */
export function initModule(moduleId: string, systemName: string): void {
  const modulePath = path.join(getLocalModulesDataDir(), moduleId);
  if (fs.existsSync(modulePath)) {
    throw new Error(`Module path ${modulePath} already exists. Choose a different name or remove the existing module.`);
  }

  console.log(`Initializing module "${moduleId}" for system "${systemName}" at ${modulePath}...`);

  renderTemplateTree(modulePath, {
    SYSTEM_ID: moduleId,
    SYSTEM_NAME: systemName,
    CLASS_PREFIX: toTypeScriptIdentifier(moduleId),
    MANAGED_TSCONFIG: managedTsconfigPath(modulePath),
  });

  console.log(`Module "${moduleId}" initialized successfully at ${modulePath}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const moduleId = process.argv[2];
  const systemName = process.argv[3] || moduleId;
  if (!moduleId || !systemName) {
    console.error('Usage: npm run module:init <moduleId> <systemName> [--data-dir <path-to-data-dir>]');
    process.exit(1);
  }

  resolveDataDir(process.argv);

  const dataDir = getDataDir();
  console.log(`Using data directory: ${dataDir}`);

  try {
    initModule(moduleId, systemName);
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
