import { strict as assert } from 'node:assert';

import { rewriteImportsForBrowser } from '../../../server/routes/modules/rewriteModuleImports';

/**
 * Guards the runtime ESM import rewrite for installed modules
 * (`/api/modules/:id/ui`). The sharp edge: esbuild renames import collisions across
 * bundled files with `as` (`useState as useState2`), which is valid in an import clause
 * but a SYNTAX ERROR in the destructuring pattern the rewrite produces — it must become
 * `useState: useState2`. Getting this wrong silently breaks every multi-component
 * packaged module (the whole UI manifest fails to load → GenericActorPage fallback).
 */
export function run() {
    // Aliased named import → object-destructuring with `:`, never `as`.
    {
        const out = rewriteImportsForBrowser(
            'import { useSDK, useSDKComponents as useSDKComponents2 } from "@sheet-delver/sdk/react";'
        );
        assert.ok(
            out.includes('const { useSDK, useSDKComponents: useSDKComponents2 } = window.__SD.sdkReact;'),
            `aliased named import not converted with ':' — got: ${out}`
        );
        assert.ok(!/\bas\b/.test(out), `'as' must not survive into a destructuring binding — got: ${out}`);
    }

    // Default + aliased named (the esbuild React shape).
    {
        const out = rewriteImportsForBrowser('import React, { useState as useState2 } from "react";');
        assert.ok(out.includes('const React = window.__SD.React;'), `default binding wrong — got: ${out}`);
        assert.ok(out.includes('const { useState: useState2 } = window.__SD.React;'), `named binding wrong — got: ${out}`);
    }

    // Namespace import.
    {
        const out = rewriteImportsForBrowser('import * as SDK from "@sheet-delver/sdk";');
        assert.ok(out.includes('const SDK = window.__SD.sdk;'), `namespace binding wrong — got: ${out}`);
    }

    // Plain named import (no alias) is unchanged in shape.
    {
        const out = rewriteImportsForBrowser('import { buildModuleAssetUrl } from "@sheet-delver/sdk";');
        assert.ok(out.includes('const { buildModuleAssetUrl } = window.__SD.sdk;'), `plain named wrong — got: ${out}`);
    }

    // Unmapped specifiers (a module's own bundled deps) are left untouched.
    {
        const src = 'import { foo } from "some-bundled-lib";';
        assert.equal(rewriteImportsForBrowser(src), src, 'unmapped specifier should pass through unchanged');
    }

    // Regression: a multi-alias block must contain no `... as ...` inside any
    // `const { … } = window.__SD.*` binding.
    {
        const out = rewriteImportsForBrowser(
            [
                'import { jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";',
                'import React2, { useState as useState2, useMemo } from "react";',
                'import { buildModuleAssetUrl as buildModuleAssetUrl2 } from "@sheet-delver/sdk";',
            ].join('\n')
        );
        assert.ok(
            !/const \{[^}]*\bas\b[^}]*\} = window\.__SD/.test(out),
            `destructuring binding still contains 'as' — got: ${out}`
        );
    }

    console.log('module-ui-rewrite.test.ts passed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run();
}
