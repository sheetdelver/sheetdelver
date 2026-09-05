import type { MouseEventHandler } from 'react';
import type { SafeHtml } from '@shared/security/safeHtml';

interface SafeHtmlContentProps {
    html: SafeHtml;
    className?: string;
    onClick?: MouseEventHandler<HTMLDivElement>;
}

/** The sole reviewed React boundary permitted to materialize sanitized HTML. */
export function SafeHtmlContent({ html, className, onClick }: SafeHtmlContentProps) {
    return (
        <div
            className={className}
            onClick={onClick}
            dangerouslySetInnerHTML={{ __html: html }}
        />
    );
}
