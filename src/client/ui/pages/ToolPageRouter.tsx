'use client';

import React, { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getUIModule } from '@modules/registry/client';
import LoadingModal from '@client/ui/components/LoadingModal';
import { SurfaceHost } from '@client/ui/components/SurfaceHost';

/**
 * Generic tool page router.
 * Looks up the tool component from the module registry by systemId + toolId
 * and renders it. Lives in app/ui/pages so the Next.js route file at
 * app/tools/[systemId]/[toolId]/page.tsx stays a thin re-export.
 */
export default function ToolPageRouter({ params }: { params: Promise<{ systemId: string; toolId: string }> }) {
    const resolvedParams = use(params);
    const { systemId, toolId } = resolvedParams;
    const router = useRouter();

    const [ToolComponent, setToolComponent] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let isMounted = true;
        async function resolveTool() {
            try {
                const manifest = await getUIModule(systemId);
                if (!isMounted) return;

                if (!manifest) {
                    setError(`System context for '${systemId}' not found.`);
                    return;
                }

                const toolEntry = manifest.tools?.[toolId];
                if (toolEntry) {
                    const Component = typeof toolEntry === 'function'
                        ? React.lazy(toolEntry as any)
                        : toolEntry;
                    setToolComponent(() => Component as any);
                } else {
                    setError(`Tool '${toolId}' for system '${systemId}' not found.`);
                }
            } catch (e: any) {
                setError(`Failed to load tool: ${e.message}`);
            }
        }
        resolveTool();
        return () => { isMounted = false; };
    }, [systemId, toolId]);

    if (error) {
        return (
            <div className="sd-ui-page flex items-center justify-center p-4">
                <div className="sd-ui-panel-raised text-center p-8 rounded max-w-md">
                    <h1 className="sd-ui-danger text-xl font-bold mb-2">Error Loading Tool</h1>
                    <p className="sd-ui-muted">{error}</p>
                    <button
                        onClick={() => router.push('/')}
                        className="sd-ui-button mt-4 px-4 py-2"
                    >
                        Back to Dashboard
                    </button>
                </div>
            </div>
        );
    }

    const Loading = <LoadingModal message="Loading Tool..." />;

    if (!ToolComponent) return Loading;

    return (
        <SurfaceHost moduleId={systemId} surface="tools" loading={Loading}>
            <ToolComponent />
        </SurfaceHost>
    );
}
