import type { ModuleDashboardAction, UIModuleManifest } from '@shared/sdk';

const MAX_ACTIONS = 12;
const ACTION_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const TOOL_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface ResolvedDashboardActions {
    actions: ModuleDashboardAction[];
    rejected: number;
}

/** Validate UI-manifest contributions at the host boundary, including managed ESM. */
export function resolveDashboardActions(manifest: UIModuleManifest): ResolvedDashboardActions {
    if (manifest.dashboardActions === undefined) return { actions: [], rejected: 0 };

    const raw = manifest.dashboardActions;
    if (!Array.isArray(raw)) return { actions: [], rejected: 1 };

    const actions: ModuleDashboardAction[] = [];
    const seen = new Set<string>();
    let rejected = Math.max(0, raw.length - MAX_ACTIONS);

    for (const candidate of raw.slice(0, MAX_ACTIONS) as unknown[]) {
        if (!candidate || typeof candidate !== 'object') { rejected += 1; continue; }
        const row = candidate as Record<string, unknown>;
        const id = typeof row.id === 'string' ? row.id.trim() : '';
        const label = typeof row.label === 'string' ? row.label.trim() : '';
        const section = row.section;
        const placement = section === undefined ? {} : { section: section as 'tools' | 'gm' };
        const description = row.description === undefined ? undefined
            : typeof row.description === 'string' ? row.description.trim() : null;

        if ((section !== undefined && section !== 'tools' && section !== 'gm')
            || !ACTION_ID.test(id) || seen.has(id) || !label || label.length > 80
            || description === null || (description && description.length > 160)) {
            rejected += 1;
            continue;
        }

        if (row.kind === 'tool') {
            const toolId = row.toolId;
            if (typeof toolId !== 'string' || !TOOL_ID.test(toolId)
                || !manifest.tools || !Object.prototype.hasOwnProperty.call(manifest.tools, toolId)
                || typeof manifest.tools[toolId] !== 'function') {
                rejected += 1;
                continue;
            }
            actions.push({ kind: 'tool', id, label, ...placement, ...(description ? { description } : {}), toolId });
        } else if (row.kind === 'dialog' && typeof row.dialog === 'function') {
            actions.push({ kind: 'dialog', id, label, ...placement, ...(description ? { description } : {}),
                dialog: row.dialog as Extract<ModuleDashboardAction, { kind: 'dialog' }>['dialog'] });
        } else {
            rejected += 1;
            continue;
        }
        seen.add(id);
    }

    return { actions, rejected };
}

export function dashboardToolHref(moduleId: string, toolId: string): string {
    return `/tools/${encodeURIComponent(moduleId)}/${encodeURIComponent(toolId)}`;
}

/** Placement is not permission to read or write the tool's data. */
export function dashboardActionsForSection(actions: ModuleDashboardAction[], section: 'tools' | 'gm'): ModuleDashboardAction[] {
    return actions.filter(action => (action.section ?? 'tools') === section);
}
