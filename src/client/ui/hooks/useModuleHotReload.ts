'use client';

import { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { UIModuleManifest } from '@shared/sdk';
import { getUIModule, invalidateModuleSourceCache } from '@modules/registry/client';

interface UseModuleHotReloadOptions {
    appSocket: Socket | null;
    systemId: string | null | undefined;
}

export function useModuleHotReload({ appSocket, systemId }: UseModuleHotReloadOptions): UIModuleManifest | null {
    const [activeUIModule, setActiveUIModule] = useState<UIModuleManifest | null>(null);
    const systemIdRef = useRef(systemId);

    useEffect(() => {
        systemIdRef.current = systemId;
    }, [systemId]);

    useEffect(() => {
        let isMounted = true;

        async function hydrateUI() {
            if (systemId) {
                const uiManifest = await getUIModule(systemId);
                if (isMounted) {
                    setActiveUIModule(uiManifest || null);
                }
            } else if (isMounted) {
                setActiveUIModule(null);
            }
        }

        hydrateUI();
        return () => {
            isMounted = false;
        };
    }, [systemId]);

    useEffect(() => {
        if (!appSocket) return;

        const handleModuleCacheInvalidation = ({ moduleId }: { moduleId?: string }) => {
            invalidateModuleSourceCache();
            if (systemIdRef.current?.toLowerCase() === moduleId?.toLowerCase()) {
                setActiveUIModule(null);
            }
        };

        appSocket.on('moduleSourceChanged', handleModuleCacheInvalidation);
        appSocket.on('moduleStateChanged', handleModuleCacheInvalidation);
        appSocket.on('moduleRegistryChanged', handleModuleCacheInvalidation);

        return () => {
            appSocket.off('moduleSourceChanged', handleModuleCacheInvalidation);
            appSocket.off('moduleStateChanged', handleModuleCacheInvalidation);
            appSocket.off('moduleRegistryChanged', handleModuleCacheInvalidation);
        };
    }, [appSocket]);

    return activeUIModule;
}
