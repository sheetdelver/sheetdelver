'use client';

import type { CSSProperties } from 'react';
import { useSDK } from '@shared/sdk/react';
import type { PageHeaderProps } from '@shared/sdk/page-header';

/** Shared two-part module page chrome. No retained registration or global state. */
export default function PageHeader({ context, heading, onBack, theme }: PageHeaderProps) {
    const { navigate } = useSDK();
    const style = {
        '--sd-header-bg': theme?.background,
        '--sd-header-fg': theme?.foreground,
        '--sd-header-muted': theme?.muted,
        '--sd-header-border': theme?.border,
        '--sd-header-accent': theme?.accent,
        '--sd-header-icon-bg': theme?.iconBackground,
        '--sd-header-font': theme?.fontFamily,
        '--sd-header-heading-font': theme?.headingFontFamily,
    } as CSSProperties;
    return <div className="sd-page-header" style={style}>
        <nav className="sd-page-header-nav" aria-label="Page navigation">
            <button type="button" onClick={onBack ?? (() => navigate('/'))}>
                <span aria-hidden="true">←</span> Back to Dashboard
            </button>
            {context && <span className="sd-page-header-context">{context}</span>}
        </nav>
        {heading && <header className="sd-page-header-heading">
            <div className="sd-page-header-identity">
                {heading.icon && <div className="sd-page-header-icon" aria-hidden="true">{heading.icon}</div>}
                <div className="sd-page-header-title">
                    <h1>{heading.title}</h1>
                    {heading.subtitle && <p>{heading.subtitle}</p>}
                </div>
            </div>
            {heading.actions && <div className="sd-page-header-actions">{heading.actions}</div>}
        </header>}
    </div>;
}
