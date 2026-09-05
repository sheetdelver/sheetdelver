import React from 'react';
import Link from 'next/link';
import { Settings } from 'lucide-react';

interface SetupViewProps {
    appVersion: string;
}

export const SetupView = ({ appVersion }: SetupViewProps) => {
    return (
        <div className="flex flex-col items-center justify-center min-h-[80vh] text-center p-8 space-y-6 animate-in fade-in duration-700">
            <h1 className="text-4xl font-bold mb-4 text-amber-500" style={{ fontFamily: 'var(--font-cinzel), serif' }}>
                SheetDelver
            </h1>

            <div className="max-w-md w-full bg-neutral-900/80 border border-neutral-800 p-8 rounded-xl shadow-2xl backdrop-blur-md">
                <div className="w-16 h-16 bg-neutral-800 rounded-full flex items-center justify-center mx-auto mb-6">
                    <svg className="w-8 h-8 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                    </svg>
                </div>

                <h2 className="text-xl font-bold mb-2">Configuration Required</h2>
                <p className="text-neutral-400 mb-6 text-sm leading-relaxed">
                    SheetDelver has not been configured for a Foundry world yet.
                </p>

                <p className="text-neutral-500 mb-4 text-sm">
                    Continue from the configured local admin origin.
                </p>

                {/* The shell keeps one admin route; origin/network middleware remains authoritative. */}
                <Link
                    href="/admin"
                    className="inline-flex items-center justify-center gap-2 bg-amber-600 hover:bg-amber-500 text-black font-bold px-4 py-2 rounded-md transition-colors mb-6"
                >
                    <Settings className="h-4 w-4" aria-hidden="true" />
                    Open Admin
                </Link>

                <p className="text-xs text-neutral-600 mb-6">
                    Looking for an active world...
                </p>

                <div className="flex justify-center gap-4">
                    <a
                        href="https://github.com/juvinious/sheet-delver"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 opacity-30 hover:opacity-100 transition-opacity text-sm font-mono"
                    >
                        <img src="https://img.shields.io/badge/github-repo-blue?logo=github" alt="GitHub Repo" className="opacity-80" />
                    </a>
                </div>
            </div>

            <p className="text-[10px] font-mono opacity-20 mt-8">v{appVersion || '...'}</p>
        </div>
    );
};
