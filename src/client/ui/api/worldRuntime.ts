/** One browser asset lifetime. A replacement token is never granted to old code. */
export class BrowserWorldRuntime {
    private observed = false;
    private retired = false;
    private token: string | null = null;
    observe(next: string | null): boolean {
        if (this.retired) return false;
        if (!this.observed) { this.observed = true; this.token = next; return false; }
        if (this.token === next) return false;
        this.retired = true;
        return true;
    }
    headers(): Record<string, string> { return this.token ? { 'X-SheetDelver-Runtime': this.token } : {}; }
}
const runtime = new BrowserWorldRuntime();
/** Non-secret module-build fence; never an authentication credential. */
export function observeWorldRuntime(next: string | null): boolean { return runtime.observe(next); }
export function worldRuntimeHeaders(): Record<string, string> {
    return runtime.headers();
}
