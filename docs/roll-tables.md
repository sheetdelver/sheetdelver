# Roll Table Runtime

Sheet Delver treats roll tables as documents and exposes module-safe table draws
through the SDK runtime. Module code should not reach into Foundry socket helpers
or local package internals to draw tables.

---

## Server Runtime

Module server routes receive a user-bound request runtime:

```ts
import { json, type ModuleRouteTable } from '@sheet-delver/sdk/server';

export const apiRoutes: ModuleRouteTable = {
    'tables/[uuid]/draw': async (req, { params }) => {
        const { route } = await params;
        const uuid = route[1];
        const result = await req.runtime.tables.draw(uuid);
        return json(result);
    },
};
```

`req.runtime.tables.draw(uuid, options?)` resolves and rolls the table through
the platform runtime. It is the preferred module route primitive for table draws.

---

## Shared Utility

For pure in-memory logic and tests, the shared SDK also exports
`simulateTableDraw(table, options?)` from `@sheet-delver/sdk`. That helper works
with an already-fetched table document and does not contact Foundry.

---

## Data Rules

- World roll tables are primary documents and should be read through
  `runtime.documents` or host document APIs.
- Compendium roll tables must come from declared module compendium packs.
- Missing undeclared compendium rows fail closed; fix the module manifest instead
  of relying on live Foundry fallback behavior.
- Realtime table changes surface through the SDK signal bus as
  `document:changed` / `document:listInvalidated` for type `RollTable`.
