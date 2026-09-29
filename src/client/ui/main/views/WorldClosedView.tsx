import React from 'react';
import type { AppSystemInfo } from '@shared/interfaces';

interface WorldClosedViewProps {
    system: AppSystemInfo | null;
    appVersion: string;
}

/**
 * Displayed when the Foundry world is running but the service account cannot connect.
 * Shows world info (title, description) identical to the LoginView info card,
 * but without the login form. Lets the user know the service is retrying.
 */
export const WorldClosedView = ({ system, appVersion }: WorldClosedViewProps) => {
    return (
        <div className="flex flex-col items-center justify-center min-h-[80vh] text-center p-4 sm:p-8 space-y-6 animate-in fade-in duration-700">
            <h1 className="text-4xl sm:text-6xl font-black tracking-tighter mb-2 underline underline-offset-8 decoration-4 sd-ui-accent" style={{ fontFamily: 'var(--font-cinzel), serif' }}>
                SheetDelver
            </h1>
            <p className="text-xs font-mono opacity-40 mb-8">v{appVersion || '...'}</p>

            <div className="sd-ui-panel p-5 sm:p-8 rounded-xl backdrop-blur-md max-w-lg shadow-2xl w-full">
                <h2 className="text-2xl font-bold sd-ui-accent mb-4">No World Available</h2>
                <p className="text-lg opacity-80 mb-6 leading-relaxed">
                    No world is available to login, please check back later.
                </p>

                <div className="flex justify-center gap-4">
                    <a
                        href="https://github.com/juvinious/sheet-delver"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 opacity-50 hover:opacity-100 transition-opacity text-sm font-mono"
                    >
                        <img src="https://img.shields.io/badge/github-repo-blue?logo=github" alt="GitHub Repo" className="opacity-80" />
                    </a>
                </div>
            </div>
        </div>
    );
};
