'use client';

import { useEffect, useRef, type RefObject } from 'react';

const activeDialogs: HTMLElement[] = [];
let originalOverflow = '';

/** Core dialog keyboard/focus convention, shared by image and journal overlays. */
export function useModalFocus(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
    const closeRef = useRef(onClose);
    useEffect(() => { closeRef.current = onClose; }, [onClose]);
    useEffect(() => {
        if (!open || !ref.current) return;
        const dialog = ref.current;
        const previous = document.activeElement;
        if (!activeDialogs.length) originalOverflow = document.body.style.overflow;
        // Child effects may enter first when an entire nested tree mounts.
        const descendant = activeDialogs.findIndex(other => dialog.contains(other));
        activeDialogs.splice(descendant < 0 ? activeDialogs.length : descendant, 0, dialog);
        document.body.style.overflow = 'hidden';
        if (activeDialogs.at(-1) === dialog) dialog.focus();
        const keydown = (event: KeyboardEvent) => {
            if (activeDialogs.at(-1) !== dialog) return;
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
        // A saved/disabled or realtime-removed control may leave focus on body.
        // Keep Escape and Tab containment working until the top dialog closes.
        document.addEventListener('keydown', keydown);
        return () => {
            document.removeEventListener('keydown', keydown);
            const wasTop = activeDialogs.at(-1) === dialog;
            const index = activeDialogs.indexOf(dialog);
            if (index >= 0) activeDialogs.splice(index, 1);
            document.body.style.overflow = activeDialogs.length ? 'hidden' : originalOverflow;
            if (wasTop && previous instanceof HTMLElement && previous.isConnected) previous.focus();
        };
    }, [ref, open]);
}
