import React from 'react';
import { getUIModule } from '@modules/registry/client';
import { SurfaceHost } from '@client/ui/components/SurfaceHost';
import { logger } from '@shared/utils/logger';
import type { ModuleDashboardAction, ModuleDashboardDialogProps } from '@shared/sdk';
import { dashboardActionsForSection, resolveDashboardActions } from './dashboardActions';
import { DashboardActionCards, DashboardActionSection } from './DashboardActionSection';

export default function SystemTools({ systemId, section = 'tools' }: { systemId: string; section?: 'tools' | 'gm' }) {
    const [actions, setActions] = React.useState<ModuleDashboardAction[] | null>(null);
    const [Dialog, setDialog] = React.useState<React.ComponentType<ModuleDashboardDialogProps> | null>(null);

    React.useEffect(() => {
        let isMounted = true;
        async function resolveTools() {
            const manifest = await getUIModule(systemId);
            if (!isMounted || !manifest) return;

            const resolved = resolveDashboardActions(manifest);
            if (resolved.rejected) logger.warn(`[SystemTools] Rejected ${resolved.rejected} invalid dashboard actions for ${systemId}.`);
            setActions(resolved.actions);
        }
        void resolveTools().catch(error => logger.warn(`[SystemTools] Could not load dashboard actions for ${systemId}.`, error));
        return () => { isMounted = false; };
    }, [systemId]);

    const openDialog = (id: string) => {
        const action = actions && dashboardActionsForSection(actions, section).find(row => row.id === id);
        if (action?.kind === 'dialog') setDialog(() => React.lazy(action.dialog));
    };

    if (actions !== null) {
        const visibleActions = dashboardActionsForSection(actions, section);
        if (visibleActions.length === 0) return null;
        const Cards = section === 'gm' ? DashboardActionCards : DashboardActionSection;
        return <>
            <Cards systemId={systemId} actions={visibleActions} onOpenDialog={openDialog} />
            {Dialog && <SurfaceHost
                moduleId={systemId}
                surface="dashboardDialog"
                fallback={<div className="sd-ui-panel-raised rounded-lg p-4">
                    <p className="sd-ui-danger">This tool could not be opened.</p>
                    <button type="button" className="sd-ui-button mt-3 px-3 py-2" onClick={() => setDialog(null)}>Close</button>
                </div>}
            >
                <Dialog onClose={() => setDialog(null)} />
            </SurfaceHost>}
        </>;
    }

    return null;
}
