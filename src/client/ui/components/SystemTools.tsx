import React from 'react';
import { getUIModule } from '@modules/registry/client';
import { SurfaceHost } from '@client/ui/components/SurfaceHost';

interface SystemToolsProps {
    systemId: string;
    setLoading: (loading: boolean) => void;
    setLoginMessage: (msg: string) => void;
    theme: any;
    token: string | null;
}

export default function SystemTools({ systemId, setLoading, setLoginMessage, theme, token }: SystemToolsProps) {
    const [ResolvedTools, setResolvedTools] = React.useState<React.ComponentType<any> | null>(null);
    const [LoadingComponent, setLoadingComponent] = React.useState<React.ComponentType<any> | null>(null);

    React.useEffect(() => {
        let isMounted = true;
        async function resolveTools() {
            const manifest = await getUIModule(systemId);
            if (!isMounted || !manifest) return;

            if (manifest.dashboardLoading) {
                setLoadingComponent(() => manifest.dashboardLoading as React.ComponentType<any>);
            }

            if (manifest.dashboardTools) {
                const toolsEntry = manifest.dashboardTools;
                const Component = typeof toolsEntry === 'function'
                    ? React.lazy(toolsEntry as any)
                    : toolsEntry;
                
                setResolvedTools(() => Component as any);
            }
        }
        resolveTools();
        return () => { isMounted = false; };
    }, [systemId]);

    if (ResolvedTools) {
        return (
            <SurfaceHost
                moduleId={systemId}
                surface="dashboardTools"
                loading={LoadingComponent ? <LoadingComponent /> : null}
            >
                <ResolvedTools
                    setLoading={setLoading}
                    setLoginMessage={setLoginMessage}
                    theme={theme}
                    token={token}
                />
            </SurfaceHost>
        );
    }

    return null;
}
