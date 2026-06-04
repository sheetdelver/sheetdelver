/**
 * Package-time Tailwind compile for modules (ADR-0027 section M, Phase 6.5).
 *
 * A module that authors in Tailwind utilities ships an entry at `src/styles/tailwind.css`
 * (decision 38). At package time we compile it into a self-contained, scoped CSS artifact
 * (`assets/<id>.tailwind.css`, decision 37) so an installed module — whose source the host
 * can no longer scan — still carries its utilities.
 *
 * The compile:
 *   - resolves the bare `@sheet-delver/sdk/theme.css` import to the real SDK theme file so
 *     the platform's custom tokens (font-imfell, base colors) register (decision 34);
 *   - injects the module's own `src/**` as a Tailwind content `@source` (the module lives
 *     under the gitignored data dir, which Tailwind v4 auto-detection skips);
 *   - scope-wraps every emitted rule under `.sdk-module--<id>` so it cannot touch the host
 *     page. Preflight is omitted by the entry (theme + utilities layers only) — the host
 *     supplies the global reset (decision 34) — so there is no `*` reset to fight with.
 *
 * Both `check-module.ts` (dry validation) and `package-module.ts` (release) call this, so the
 * compile can never drift between the two.
 */

import fs from 'node:fs';
import path from 'node:path';
import postcss, { type Root, type Rule, type PluginCreator } from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import { TAILWIND_ENTRY_REL, SDK_THEME_SPECIFIER, SDK_THEME_REL } from './build-config';

const toPosix = (p: string) => p.replace(/\\/g, '/');

/** Absolute path to the shared SDK theme, resolved from the platform repo root (cwd). */
function sdkThemePath(): string {
    return path.join(process.cwd(), SDK_THEME_REL);
}

/**
 * PostCSS plugin: prefix every emitted style rule under `.sdk-module--<id>`.
 * `:root`/`:host` collapse to the scope root; rules inside `@keyframes` (the `0%`/`100%`
 * frames) are left alone, and bodiless at-rules (`@property`, `@font-face`) carry no style
 * rule for `walkRules` to touch, so they stay global by construction.
 */
function scopePlugin(scope: string): PluginCreator<void> {
    const creator: PluginCreator<void> = () => ({
        postcssPlugin: 'sd-module-scope',
        OnceExit(root: Root) {
            root.walkRules((rule: Rule) => {
                const parent = rule.parent;
                if (parent && parent.type === 'atrule' && (parent as { name?: string }).name === 'keyframes') return;
                const scoped = rule.selectors.map((selector) => {
                    const s = selector.trim();
                    if (s === ':root' || s === ':host' || s === 'html') return scope;
                    if (s === scope || s.startsWith(`${scope} `)) return s;
                    return `${scope} ${s}`;
                });
                rule.selectors = Array.from(new Set(scoped));
            });
        },
    });
    creator.postcss = true;
    return creator;
}

/** Does this module ship a Tailwind entry? */
export function hasTailwindEntry(modulePath: string): boolean {
    return fs.existsSync(path.join(modulePath, TAILWIND_ENTRY_REL));
}

/**
 * Compile a module's Tailwind entry into scoped CSS. Returns the CSS string, or `null` when
 * the module has no `src/styles/tailwind.css` (decisions 37/38 — no entry ⇒ no artifact).
 *
 * @param sourceGlobOverride - scan target instead of `<modulePath>/src` (used by the checker
 *   probe to point at a synthesized entry's neighbour source).
 */
export async function compileModuleTailwind(
    modulePath: string,
    moduleId: string,
    options: { entryContent?: string; sourceDir?: string } = {},
): Promise<string | null> {
    const entryPath = path.join(modulePath, TAILWIND_ENTRY_REL);
    const entryContent = options.entryContent ?? (fs.existsSync(entryPath) ? fs.readFileSync(entryPath, 'utf8') : null);
    if (entryContent == null) return null;

    const sourceDir = options.sourceDir ?? path.join(modulePath, 'src');

    // Resolve the bare SDK theme specifier to the real file, and add the module's source as
    // an explicit content `@source` (belt-and-suspenders alongside `base` below).
    let input = entryContent.split(SDK_THEME_SPECIFIER).join(toPosix(sdkThemePath()));
    input += `\n@source "${toPosix(sourceDir)}";\n`;

    // `base` confines Tailwind's automatic content detection to THIS module. Without it the
    // plugin scans from cwd (the whole platform repo), bloating every module's artifact with
    // unused platform-wide utilities. With it, only the module's own classes are emitted.
    const scope = `.sdk-module--${moduleId}`;
    const result = await postcss([tailwindcss({ base: modulePath }), scopePlugin(scope)]).process(input, { from: entryPath });
    return result.css;
}

/**
 * Probe compile used by the checker when a module has NO entry: compile a synthesized default
 * entry against the module's source. A non-trivial utility count means the module relies on
 * Tailwind but forgot its entry (it would ship unstyled) — the checker turns that into a
 * failure (decision 39). Returns the number of generated utility rules.
 */
export async function probeTailwindUtilityCount(modulePath: string, moduleId: string): Promise<number> {
    const synthesized =
        `@import "tailwindcss/theme.css" layer(theme);\n` +
        `@import "${SDK_THEME_SPECIFIER}";\n` +
        `@import "tailwindcss/utilities.css" layer(utilities);\n`;
    const css = await compileModuleTailwind(modulePath, moduleId, { entryContent: synthesized });
    if (!css) return 0;
    // Count scoped utility class rules (`.sdk-module--<id> .<util> {`).
    const matches = css.match(new RegExp(`\\.sdk-module--${moduleId}\\s+\\.`, 'g'));
    return matches ? matches.length : 0;
}
