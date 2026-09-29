import React from 'react';

interface LoadingModalProps {
    message: string;
    submessage?: string;
    visible?: boolean;
    theme?: {
        overlay?: string;
        container?: string;
        spinner?: string;
        text?: string;
        subtext?: string;
    };
}

const defaultTheme = {
    overlay: "sd-ui-overlay absolute inset-0 backdrop-blur-md transition-opacity",
    container: "sd-ui-panel-raised relative z-10 p-8 rounded-2xl backdrop-blur-xl shadow-2xl text-center flex flex-col items-center space-y-4 max-w-sm w-full mx-4 animate-in zoom-in-95 duration-300",
    spinner: "sd-ui-spinner w-12 h-12 border-4 border-t-transparent rounded-full animate-spin mx-auto",
    text: "text-xl font-bold font-sans",
    subtext: "sd-ui-muted text-sm font-mono tracking-wide"
};

export default function LoadingModal({ message, submessage, visible = true, theme }: LoadingModalProps) {
    if (!visible) return null;
    const t = { ...defaultTheme, ...theme };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            {/* Overlay background - absolute to parent fixed wrapper */}
            <div className={t.overlay} />

            <div className={t.container}>
                <div className={t.spinner}></div>
                <div className="space-y-1">
                    <h2 className={t.text}>{message}</h2>
                    {submessage && <p className={t.subtext}>{submessage}</p>}
                </div>
            </div>
        </div>
    );
}
