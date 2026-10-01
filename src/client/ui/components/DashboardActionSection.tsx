'use client';

import Link from 'next/link';
import { Wrench } from 'lucide-react';
import type { ModuleDashboardAction } from '@shared/sdk';
import { dashboardToolHref } from './dashboardActions';

const cardClass = 'sd-ui-panel-raised group flex w-full items-center gap-4 rounded-xl p-4 text-left shadow-lg backdrop-blur-md transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl';

export function DashboardActionSection({ systemId, actions, onOpenDialog }: {
    systemId: string;
    actions: ModuleDashboardAction[];
    onOpenDialog: (id: string) => void;
}) {
    return (
        <section aria-label="System Tools">
            <div className="mb-4 flex items-center gap-3">
                <h3 className="sd-ui-accent text-xl font-bold uppercase tracking-widest">Tools</h3>
                <div className="sd-ui-divider h-px flex-1 border-t" />
            </div>
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
                {actions.map(action => {
                    const contents = <>
                        <span className="sd-ui-inset sd-ui-accent flex h-16 w-16 shrink-0 items-center justify-center rounded-lg">
                            <Wrench aria-hidden="true" className="h-8 w-8" />
                        </span>
                        <span className="min-w-0">
                            <span className="sd-ui-accent block truncate text-lg font-bold">{action.label}</span>
                            {action.description && <span className="sd-ui-muted mt-1 block text-sm">{action.description}</span>}
                        </span>
                    </>;
                    return action.kind === 'tool'
                        ? <Link key={action.id} href={dashboardToolHref(systemId, action.toolId)} className={cardClass}>{contents}</Link>
                        : <button key={action.id} type="button" aria-haspopup="dialog" onClick={() => onOpenDialog(action.id)} className={cardClass}>{contents}</button>;
                })}
            </div>
        </section>
    );
}
