let servingToken: string | null = null;
/** Non-secret module-build fence; never an authentication credential. */
export function observeWorldRuntime(next: string | null): boolean {
    const changed = servingToken !== null && next !== servingToken;
    servingToken = next;
    return changed;
}
export function worldRuntimeHeaders(): Record<string, string> {
    return servingToken ? { 'X-SheetDelver-Runtime': servingToken } : {};
}
