import type { ReactNode } from 'react';

/** Presentation tokens only: Core owns header structure and responsive layout. */
export interface PageHeaderTheme {
    background?: string;
    foreground?: string;
    muted?: string;
    border?: string;
    accent?: string;
    iconBackground?: string;
    fontFamily?: string;
    headingFontFamily?: string;
}

/** Client-only props. Omit heading on sheets; keep Actor identity in sheet content. */
export interface PageHeaderProps {
    context?: string;
    /** Default: SDK navigation to /. Override for a module-owned discard flow. */
    onBack?: () => void;
    heading?: {
        title: string;
        subtitle?: string;
        /** Decorative icon; Core hides it from assistive technology. */
        icon?: ReactNode;
        /** Interactive tool controls retain their own labels and handlers. */
        actions?: ReactNode;
    };
    theme?: PageHeaderTheme;
}
