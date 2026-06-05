// ─── Module JS import rewriter ───────────────────────────────────────────────
//
// Runtime-installed (managed) modules can't be in the Next.js webpack bundle.
// They are served via GET /api/modules/:id/ui as native ESM so the browser can
// import them with /* webpackIgnore: true */.
//
// The compiled artifact uses bare ESM specifiers ('react', '@sheet-delver/sdk')
// that the browser's native loader can't resolve without an importmap. We rewrite
// those imports server-side to reference window.__SD, which the SDKGlobalProvider
// sets synchronously during page load. This shares the host's React instance so
// module context (useSDK, useSDKComponents) works correctly.
//
// Extracted from createModuleRouter so it is unit-testable without the Express
// router (see module-ui-rewrite.test.ts).

export const GLOBAL_MAP: Record<string, string> = {
    'react':                   'window.__SD.React',
    'react/jsx-runtime':       'window.__SD.ReactJSX',
    'react-dom':               'window.__SD.React',
    '@sheet-delver/sdk':       'window.__SD.sdk',
    // Client subpath (ADR-0027 decision 2). `@sheet-delver/sdk/server` is intentionally
    // absent — a UI bundle importing it stays unresolved (server-only rejected from UI).
    '@sheet-delver/sdk/react': 'window.__SD.sdkReact',
};

/**
 * Rewrites bare ESM import statements in a compiled module artifact to use the
 * window.__SD globals, making the file loadable by the browser's native ESM loader
 * without an importmap.
 *
 * Handles the forms esbuild produces:
 *   import { a, b as c } from "module"
 *   import X, { a } from "module"
 *   import * as X from "module"
 *
 * Critically, esbuild renames collisions across bundled files with `as`
 * (`useState as useState2`). That is valid in an import clause but a SYNTAX ERROR in
 * a destructuring pattern, where it must be `useState: useState2` — so each `X as Y`
 * is converted to `X: Y`. Getting this wrong breaks every multi-component module.
 */
export function rewriteImportsForBrowser(code: string): string {
    return code.replace(
        /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/gm,
        (match, imports: string, source: string) => {
            const global = GLOBAL_MAP[source];
            if (!global) return match;

            const parts: string[] = [];
            const trimmed = imports.trim();

            const toDestructure = (names: string): string =>
                names
                    .split(',')
                    .map(s => s.trim())
                    .filter(Boolean)
                    .map(spec => {
                        const aliased = spec.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
                        return aliased ? `${aliased[1]}: ${aliased[2]}` : spec;
                    })
                    .join(', ');

            // namespace: * as X
            const nsMatch = trimmed.match(/^\*\s+as\s+(\w+)$/);
            if (nsMatch) {
                parts.push(`const ${nsMatch[1]} = ${global};`);
                return parts.join('\n');
            }

            // default + possibly named: X, { a, b as c }  or  X
            const defaultMatch = trimmed.match(/^(\w+)(?:\s*,\s*\{([^}]*)\})?$/);
            if (defaultMatch) {
                parts.push(`const ${defaultMatch[1]} = ${global};`);
                if (defaultMatch[2]) {
                    parts.push(`const { ${toDestructure(defaultMatch[2])} } = ${global};`);
                }
                return parts.join('\n');
            }

            // named only: { a, b as c }
            const namedMatch = trimmed.match(/^\{([^}]*)\}$/);
            if (namedMatch) {
                parts.push(`const { ${toDestructure(namedMatch[1])} } = ${global};`);
                return parts.join('\n');
            }

            return match;
        }
    );
}
