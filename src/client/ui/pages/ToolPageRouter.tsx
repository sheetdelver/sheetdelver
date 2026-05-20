'use client';

import React, { use, useEffect, useState, Suspense } from 'react';
import { useRouter } from 'next/navigation';
import { getUIModule } from '@modules/registry/client';
import LoadingModal from '@client/ui/components/LoadingModal';

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
            <div className="min-h-screen flex items-center justify-center bg-neutral-900 text-white">
                <div className="text-center p-8 bg-black/40 rounded border border-white/10">
                    <h1 className="text-xl font-bold text-red-500 mb-2">Error Loading Tool</h1>
                    <p className="opacity-70">{error}</p>
                    <button
                        onClick={() => router.push('/')}
                        className="mt-4 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 rounded transition-colors pointer"
                    >
                        Back to Dashboard
                    </button>
                </div>
            </div>
        );
    }

    const Loading = (
        <LoadingModal
            message="Loading Tool..."
            theme={{
                overlay: "absolute inset-0 bg-black/60 backdrop-blur-md transition-opacity",
                container: "relative z-10 p-8 rounded-2xl bg-neutral-900/95 backdrop-blur-xl border border-white/10 shadow-2xl text-center space-y-4 max-w-sm w-full mx-4 animate-in zoom-in-95 duration-300",
                spinner: "w-12 h-12 border-4 border-amber-500 border-t-transparent rounded-full animate-spin mx-auto",
                text: "text-xl font-bold text-white font-sans"
            }}
        />
    );

    if (!ToolComponent) return Loading;

    return (
        <Suspense fallback={Loading}>
            <ToolComponent />
        </Suspense>
    );
}
