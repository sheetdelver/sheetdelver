// ---------------------------------------------------------------------------
// @sheet-delver/sdk/server — server entry point (ADR-0027 decision 2).
//
// Server runtime types (`ModuleRuntime`/`ModuleRequestRuntime` and the document /
// roll / table / datastore / compendium surfaces) plus the route contract and the
// `json` / `error` response helpers. Rejected from UI bundles.
// ---------------------------------------------------------------------------

export {
    json,
    error,
} from './server';

export type {
    ModuleServerRequest,
    ModuleServerParams,
    ModuleServerResponse,
    ModuleRouteHandler,
    ModuleRouteTable,
    ModuleServerExport,
    ModuleAccessContext,
} from './server';

export type {
    ModuleRuntime,
    ModuleRequestRuntime,
    DataStore,
    CompendiumPackReader,
    ReadonlyDocumentStore,
    DocumentStore,
    DocumentQuery,
    DocumentListResult,
    DocumentOpOptions,
    ModuleOwnershipLevel,
    RollResult,
    RollRuntime,
    TableRuntime,
} from './runtime';
