'use client';

import { useEffect, useRef, type RefObject } from 'react';

/** Core dialog keyboard/focus convention, shared by image and journal overlays. */
export function useModalFocus(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
    const closeRef = useRef(onClose);
    useEffect(() => { closeRef.current = onClose; }, [onClose]);
    useEffect(() => {
        if (!open || !ref.current) return;
        const dialog = ref.current;
        const previous = document.activeElement;
        const overflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        dialog.focus();
        const keydown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeRef.current();
            } else if (event.key === 'Tab') {
                const controls = Array.from(dialog.querySelectorAll<HTMLElement>(
                    'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
                )).filter(element => element.getClientRects().length > 0);
                const first = controls[0], last = controls[controls.length - 1];
                if (!first) { event.preventDefault(); dialog.focus(); }
                else if (!dialog.contains(document.activeElement) || document.activeElement === dialog) {
                    event.preventDefault(); (event.shiftKey ? last : first).focus();
                } else if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault(); last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault(); first.focus();
                }
            }
        };
        dialog.addEventListener('keydown', keydown);
        return () => {
            dialog.removeEventListener('keydown', keydown);
            document.body.style.overflow = overflow;
            if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
        };
    }, [ref, open]);
}
